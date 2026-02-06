import { app } from 'electron';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { get as httpsGet } from 'https';
import path from 'path';
import type {
  ReleaseDetails,
  ReleaseUpdateCache,
  ReleaseUpdateCheckResult,
} from '../../shared/types/release';
import {
  compareSemver,
  formatPlatformLabel,
  getPrereleaseChannel,
  normalizePlatform,
  parseReleaseTag,
  parseSemver,
} from '../../shared/utils/release';

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  draft: boolean;
  body?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  target_commitish?: string | null;
}

interface GitHubRef {
  object?: {
    sha?: string;
    type?: string;
  };
}

interface GitHubTagObject {
  object?: {
    sha?: string;
    type?: string;
  };
}

const MAX_CACHE_BYTES = 10 * 1024;
const UPDATE_CACHE_FILE = 'release-update.json';

const getUpdateCachePath = (): string =>
  path.join(app.getPath('userData'), UPDATE_CACHE_FILE);

const getRepo = (): string => {
  return (
    process.env.DIVIDR_GITHUB_REPO ||
    process.env.GITHUB_REPOSITORY ||
    'talisik-ai/dividr'
  );
};

const getPlatform = (): string | null => {
  return normalizePlatform(process.platform);
};

const getInstalledTag = (version: string, platform: string): string => {
  return `v${version}-${platform}`;
};

const fetchJson = async <T>(url: string): Promise<T> => {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': `DiviDr/${app.getVersion()}`,
        Accept: 'application/vnd.github.v3+json',
      },
    };

    httpsGet(url, options, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`GitHub API returned status ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', (chunk) => (data += chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (error) {
          reject(
            new Error(
              `Failed to parse GitHub response: ${error instanceof Error ? error.message : 'Unknown error'}`,
            ),
          );
        }
      });
    }).on('error', reject);
  });
};

const fetchReleases = async (repo: string): Promise<GitHubRelease[]> => {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  return fetchJson<GitHubRelease[]>(url);
};

const fetchReleaseByTag = async (
  repo: string,
  tag: string,
): Promise<GitHubRelease> => {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  return fetchJson<GitHubRelease>(url);
};

const fetchTagCommitSha = async (
  repo: string,
  tag: string,
): Promise<string | null> => {
  try {
    const refUrl = `https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`;
    const ref = await fetchJson<GitHubRef>(refUrl);
    const objectSha = ref.object?.sha;
    const objectType = ref.object?.type;

    if (!objectSha) return null;

    if (objectType === 'commit') {
      return objectSha;
    }

    if (objectType === 'tag') {
      const tagUrl = `https://api.github.com/repos/${repo}/git/tags/${objectSha}`;
      const tagObject = await fetchJson<GitHubTagObject>(tagUrl);
      return tagObject.object?.sha || null;
    }

    return objectSha;
  } catch {
    return null;
  }
};

export const readReleaseUpdateCache = (): ReleaseUpdateCache | null => {
  const cachePath = getUpdateCachePath();
  if (!existsSync(cachePath)) return null;

  try {
    const stats = statSync(cachePath);
    if (stats.size > MAX_CACHE_BYTES) return null;

    const content = readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(content) as ReleaseUpdateCache;

    if (!parsed.latestVersion || !parsed.latestTag) return null;

    return parsed;
  } catch {
    return null;
  }
};

const writeReleaseUpdateCache = (cache: ReleaseUpdateCache): void => {
  try {
    const payload = JSON.stringify(cache, null, 2);
    if (Buffer.byteLength(payload, 'utf8') > MAX_CACHE_BYTES) return;
    writeFileSync(getUpdateCachePath(), payload, 'utf8');
  } catch {
    // Ignore cache write failures
  }
};

const filterReleasesForPlatform = (
  releases: GitHubRelease[],
  platform: string,
): Array<GitHubRelease & { version: string; tag: string }> => {
  return releases
    .filter((release) => !release.draft)
    .map((release) => {
      const parsed = parseReleaseTag(release.tag_name);
      if (!parsed || parsed.platform !== platform) return null;
      if (!parseSemver(parsed.version)) return null;
      return {
        ...release,
        version: parsed.version,
        tag: release.tag_name,
      };
    })
    .filter(Boolean) as Array<GitHubRelease & { version: string; tag: string }>;
};

const filterByChannel = (
  releases: Array<GitHubRelease & { version: string; tag: string }>,
  installedVersion: string,
): Array<GitHubRelease & { version: string; tag: string }> => {
  const installedChannel = getPrereleaseChannel(installedVersion);

  return releases.filter((release) => {
    const candidateChannel = getPrereleaseChannel(release.version);

    if (installedChannel) {
      return candidateChannel === installedChannel;
    }

    return candidateChannel === null;
  });
};

const selectLatestRelease = (
  releases: Array<GitHubRelease & { version: string; tag: string }>,
): (GitHubRelease & { version: string; tag: string }) | null => {
  if (releases.length === 0) return null;
  const sorted = [...releases].sort((a, b) =>
    compareSemver(a.version, b.version),
  );
  return sorted[sorted.length - 1];
};

export const checkForReleaseUpdates =
  async (): Promise<ReleaseUpdateCheckResult> => {
    const installedVersion = app.getVersion();
    const platform = getPlatform();

    if (!platform) {
      return {
        success: false,
        updateAvailable: false,
        installedVersion,
        installedTag: 'unknown',
        error: `Unsupported platform ${formatPlatformLabel(process.platform)}`,
      };
    }

    try {
      const repo = getRepo();
      const releases = await fetchReleases(repo);
      const platformReleases = filterReleasesForPlatform(releases, platform);
      const channelReleases = filterByChannel(
        platformReleases,
        installedVersion,
      );
      const latest = selectLatestRelease(channelReleases);

      if (!latest) {
        return {
          success: true,
          updateAvailable: false,
          installedVersion,
          installedTag: getInstalledTag(installedVersion, platform),
        };
      }

      const updateAvailable =
        compareSemver(latest.version, installedVersion) > 0;
      const cache: ReleaseUpdateCache = {
        latestVersion: latest.version,
        latestTag: latest.tag,
        latestTitle: latest.name || latest.tag,
        checkedAt: new Date().toISOString(),
      };

      writeReleaseUpdateCache(cache);

      return {
        success: true,
        updateAvailable,
        installedVersion,
        installedTag: getInstalledTag(installedVersion, platform),
        latest: cache,
      };
    } catch (error) {
      return {
        success: false,
        updateAvailable: false,
        installedVersion,
        installedTag: getInstalledTag(installedVersion, platform ?? 'unknown'),
        error: error instanceof Error ? error.message : 'Update check failed',
      };
    }
  };

export const getInstalledReleaseDetails =
  async (): Promise<ReleaseDetails | null> => {
    const platform = getPlatform();
    if (!platform) return null;

    const version = app.getVersion();
    const tag = getInstalledTag(version, platform);

    try {
      const repo = getRepo();
      const release = await fetchReleaseByTag(repo, tag);
      const commit = await fetchTagCommitSha(repo, tag);

      return {
        tag,
        title: release.name || release.tag_name || tag,
        notes: release.body || '',
        publishedAt: release.published_at || release.created_at || null,
        commit,
      };
    } catch {
      return null;
    }
  };
