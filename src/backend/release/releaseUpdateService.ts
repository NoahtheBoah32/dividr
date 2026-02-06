import { app } from 'electron';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import type { IncomingHttpHeaders } from 'http';
import { get as httpsGet } from 'https';
import path from 'path';
import type {
  ReleaseDetailsResult,
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

class GitHubApiError extends Error {
  status: number;
  url: string;
  payload: unknown;
  headers: IncomingHttpHeaders;
  rateLimitResetAt: string | null;
  isRateLimited: boolean;

  constructor(
    message: string,
    status: number,
    url: string,
    payload: unknown,
    headers: IncomingHttpHeaders,
    rateLimitResetAt: string | null,
    isRateLimited: boolean,
  ) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.url = url;
    this.payload = payload;
    this.headers = headers;
    this.rateLimitResetAt = rateLimitResetAt;
    this.isRateLimited = isRateLimited;
  }
}

const RATE_LIMIT_COOLDOWN_MS = 45 * 60 * 1000;
const MAX_CACHE_BYTES = 10 * 1024;
const UPDATE_CACHE_FILE = 'release-update.json';

let rateLimitCooldownUntil: number | null = null;
let lastRateLimitResetAt: string | null = null;

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

const getHeaderValue = (
  headers: IncomingHttpHeaders,
  key: string,
): string | null => {
  const value = headers[key.toLowerCase()];
  if (!value) return null;
  return Array.isArray(value) ? value[0] : value;
};

const getRateLimitResetAt = (headers: IncomingHttpHeaders): string | null => {
  const reset = getHeaderValue(headers, 'x-ratelimit-reset');
  if (!reset) return null;
  const seconds = Number(reset);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
};

const isRateLimitResponse = (
  status: number,
  message: string,
  headers: IncomingHttpHeaders,
): boolean => {
  if (status !== 403 && status !== 429) return false;
  if (/rate limit/i.test(message)) return true;
  const remaining = getHeaderValue(headers, 'x-ratelimit-remaining');
  return remaining === '0';
};

const setRateLimitCooldown = (resetAt: string | null): void => {
  const now = Date.now();
  let cooldownUntil = now + RATE_LIMIT_COOLDOWN_MS;
  if (resetAt) {
    const resetMs = Date.parse(resetAt);
    if (!Number.isNaN(resetMs)) {
      cooldownUntil = Math.max(cooldownUntil, resetMs + 1000);
    }
  }
  rateLimitCooldownUntil = cooldownUntil;
  lastRateLimitResetAt = resetAt || new Date(cooldownUntil).toISOString();
};

const isRateLimitCooldownActive = (): boolean => {
  if (!rateLimitCooldownUntil) return false;
  return Date.now() < rateLimitCooldownUntil;
};

const logRateLimit = (error: GitHubApiError): void => {
  const timestamp = new Date().toISOString();
  console.warn('⚠️ [release] GitHub API rate limit exceeded', {
    url: error.url,
    status: error.status,
    message: error.message,
    rateLimitResetAt: error.rateLimitResetAt,
    timestamp,
  });
};

const getErrorInfo = (
  error: unknown,
): {
  code: 'rate_limited' | 'network' | 'api_error';
  message: string;
  rateLimitResetAt?: string | null;
} => {
  if (error instanceof GitHubApiError) {
    if (error.isRateLimited) {
      return {
        code: 'rate_limited',
        message: error.message,
        rateLimitResetAt: error.rateLimitResetAt ?? lastRateLimitResetAt,
      };
    }
    return {
      code: 'api_error',
      message: error.message,
    };
  }

  if (error && typeof error === 'object' && 'code' in error) {
    const codeValue = (error as { code?: string }).code;
    if (
      codeValue === 'ENOTFOUND' ||
      codeValue === 'ECONNREFUSED' ||
      codeValue === 'ECONNRESET' ||
      codeValue === 'ETIMEDOUT' ||
      codeValue === 'EAI_AGAIN'
    ) {
      return {
        code: 'network',
        message: 'Network error while contacting GitHub',
      };
    }
  }

  return {
    code: 'api_error',
    message: error instanceof Error ? error.message : 'Update check failed',
  };
};

const fetchJson = async <T>(url: string): Promise<T> => {
  if (isRateLimitCooldownActive()) {
    return Promise.reject(
      new GitHubApiError(
        'GitHub API rate limit cooldown active',
        403,
        url,
        null,
        {},
        lastRateLimitResetAt,
        true,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': `DiviDr/${app.getVersion()}`,
        Accept: 'application/vnd.github.v3+json',
      },
    };

    httpsGet(url, options, (response) => {
      const status = response.statusCode ?? 0;
      const headers = response.headers ?? {};
      let data = '';
      response.on('data', (chunk) => (data += chunk));
      response.on('end', () => {
        if (status >= 400) {
          let payload: unknown = null;
          let message = `GitHub API returned status ${status}`;

          try {
            payload = JSON.parse(data);
            if (
              payload &&
              typeof payload === 'object' &&
              'message' in payload &&
              typeof (payload as { message?: string }).message === 'string'
            ) {
              message = (payload as { message: string }).message;
            }
          } catch {
            // Ignore JSON parse errors for error payloads.
          }

          const rateLimitResetAt = getRateLimitResetAt(headers);
          const isRateLimited = isRateLimitResponse(status, message, headers);
          const apiError = new GitHubApiError(
            message,
            status,
            url,
            payload,
            headers,
            rateLimitResetAt,
            isRateLimited,
          );

          if (isRateLimited) {
            setRateLimitCooldown(rateLimitResetAt);
            logRateLimit(apiError);
          }

          reject(apiError);
          return;
        }

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
  if (isRateLimitCooldownActive()) {
    return null;
  }

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

const buildFallbackUpdateResult = (
  installedVersion: string,
  platform: string,
  options?: {
    error?: string;
    errorCode?: ReleaseUpdateCheckResult['errorCode'];
    rateLimitResetAt?: string | null;
  },
): ReleaseUpdateCheckResult => {
  const latest = readReleaseUpdateCache();
  const updateAvailable = latest
    ? compareSemver(latest.latestVersion, installedVersion) > 0
    : false;

  return {
    success: false,
    updateAvailable,
    installedVersion,
    installedTag: getInstalledTag(installedVersion, platform),
    latest: latest ?? undefined,
    error: options?.error,
    errorCode: options?.errorCode,
    rateLimitResetAt: options?.rateLimitResetAt,
  };
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

    if (isRateLimitCooldownActive()) {
      return buildFallbackUpdateResult(installedVersion, platform, {
        error: 'GitHub API rate limit exceeded',
        errorCode: 'rate_limited',
        rateLimitResetAt: lastRateLimitResetAt,
      });
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
      const info = getErrorInfo(error);
      if (info.code === 'rate_limited') {
        return buildFallbackUpdateResult(installedVersion, platform, {
          error: info.message,
          errorCode: info.code,
          rateLimitResetAt: info.rateLimitResetAt,
        });
      }

      return {
        success: false,
        updateAvailable: false,
        installedVersion,
        installedTag: getInstalledTag(installedVersion, platform ?? 'unknown'),
        error: info.message,
        errorCode: info.code,
      };
    }
  };

export const getInstalledReleaseDetails =
  async (): Promise<ReleaseDetailsResult> => {
    const platform = getPlatform();
    if (!platform) {
      return {
        success: false,
        error: `Unsupported platform ${formatPlatformLabel(process.platform)}`,
        errorCode: 'api_error',
      };
    }

    if (isRateLimitCooldownActive()) {
      return {
        success: false,
        error: 'GitHub API rate limit exceeded',
        errorCode: 'rate_limited',
        rateLimitResetAt: lastRateLimitResetAt,
      };
    }

    const version = app.getVersion();
    const tag = getInstalledTag(version, platform);

    try {
      const repo = getRepo();
      const release = await fetchReleaseByTag(repo, tag);
      const commit = await fetchTagCommitSha(repo, tag);

      return {
        success: true,
        release: {
          tag,
          title: release.name || release.tag_name || tag,
          notes: release.body || '',
          publishedAt: release.published_at || release.created_at || null,
          commit,
        },
      };
    } catch (error) {
      const info = getErrorInfo(error);
      return {
        success: false,
        error: info.message,
        errorCode: info.code,
        rateLimitResetAt: info.rateLimitResetAt,
      };
    }
  };
