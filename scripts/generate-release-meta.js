/* eslint-disable no-console */
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const https = require('https');

const MAX_BODY_LENGTH = 500000; // safety guard

const platformAliases = {
  win32: 'windows',
  windows: 'windows',
  darwin: 'mac',
  mac: 'mac',
  linux: 'linux',
};

const normalizePlatform = (input) => {
  if (!input) return null;
  const key = input.toLowerCase();
  return platformAliases[key] || null;
};

const parseTag = (tag) => {
  if (!tag) return null;
  const cleaned = tag.replace(/^refs\/tags\//, '').replace(/^v/i, '');
  const parts = cleaned.split('-');
  if (parts.length < 2) return null;
  const platform = normalizePlatform(parts[parts.length - 1]);
  if (!platform) return null;
  const version = parts.slice(0, -1).join('-');
  return { version, platform, tag: `v${version}-${platform}` };
};

const getTagName = () => {
  return (
    process.env.RELEASE_TAG ||
    process.env.GITHUB_REF_NAME ||
    process.env.GITHUB_REF ||
    ''
  );
};

const fetchReleaseFromApi = (repo, tag, token) => {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;

  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'DiviDr-Release-Meta',
        Accept: 'application/vnd.github.v3+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    https
      .get(url, options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          const error = new Error(
            `GitHub API returned status ${res.statusCode}`,
          );
          error.statusCode = res.statusCode;
          reject(error);
          res.resume();
          return;
        }

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > MAX_BODY_LENGTH) {
            reject(new Error('Release body too large'));
            res.destroy();
          }
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(
              new Error(
                `Failed to parse GitHub response: ${error instanceof Error ? error.message : 'Unknown error'}`,
              ),
            );
          }
        });
      })
      .on('error', reject);
  });
};

const fetchReleaseFromGhCli = (repo, tag) => {
  const output = execFileSync(
    'gh',
    ['release', 'view', tag, '-R', repo, '--json', 'tagName,name,body'],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(output);
  return {
    tag_name: parsed.tagName,
    name: parsed.name,
    body: parsed.body,
  };
};

const main = async () => {
  const repo =
    process.env.DIVIDR_GITHUB_REPO ||
    process.env.GITHUB_REPOSITORY ||
    'talisik-ai/dividr';
  const platform =
    normalizePlatform(process.env.DIVIDR_PLATFORM) ||
    normalizePlatform(process.platform);

  if (!platform) {
    throw new Error('Unsupported platform for release metadata generation');
  }

  const tagName = getTagName();
  const parsedTag = parseTag(tagName);

  if (!parsedTag) {
    throw new Error(`Invalid release tag: ${tagName}`);
  }

  if (parsedTag.platform !== platform) {
    throw new Error(
      `Release tag platform mismatch. Expected ${platform}, got ${parsedTag.platform}`,
    );
  }

  const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const appVersion = packageJson.version;

  if (parsedTag.version !== appVersion) {
    throw new Error(
      `Tag version mismatch. package.json=${appVersion}, tag=${parsedTag.version}`,
    );
  }

  const expectedTag = `v${appVersion}-${platform}`;
  if (parsedTag.tag !== expectedTag) {
    throw new Error(`Tag does not match expected format: ${expectedTag}`);
  }

  console.log(`Fetching release metadata for ${repo} (${expectedTag})`);
  let release;
  try {
    release = await fetchReleaseFromApi(
      repo,
      expectedTag,
      process.env.GITHUB_TOKEN,
    );
  } catch (error) {
    const statusCode = error && error.statusCode;
    if (statusCode === 404) {
      console.warn(
        'GitHub API returned 404, attempting GitHub CLI fallback...',
      );
      try {
        release = fetchReleaseFromGhCli(repo, expectedTag);
      } catch (cliError) {
        throw error;
      }
    } else {
      throw error;
    }
  }

  if (!release || release.tag_name !== expectedTag) {
    throw new Error('Matching GitHub release tag not found');
  }

  const metadata = {
    appName: 'DiviDr',
    version: appVersion,
    platform,
    releaseTag: release.tag_name,
    title: release.name || release.tag_name,
    notes: release.body || '',
    commit: process.env.GITHUB_SHA || 'unknown',
    buildDate: new Date().toISOString(),
  };

  const outputPath = path.resolve(
    __dirname,
    '..',
    'public',
    'releaseMeta.json',
  );
  fs.writeFileSync(outputPath, JSON.stringify(metadata, null, 2), 'utf8');
  console.log(`Release metadata written to ${outputPath}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
