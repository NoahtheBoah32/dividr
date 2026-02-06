import type { AppPlatform } from '../types/release';

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  raw: string;
}

const STABLE_CHANNELS = new Set(['stable', 'release', 'final']);

const PLATFORM_ALIASES: Record<string, AppPlatform> = {
  win32: 'windows',
  windows: 'windows',
  win: 'windows',
  darwin: 'mac',
  mac: 'mac',
  macos: 'mac',
  linux: 'linux',
};

export const normalizePlatform = (
  input?: string | null,
): AppPlatform | null => {
  if (!input) return null;
  const key = input.toLowerCase();
  return PLATFORM_ALIASES[key] ?? null;
};

export const formatPlatformLabel = (platform?: string | null): string => {
  const normalized = normalizePlatform(platform);
  if (!normalized) {
    return platform ? platform.toString() : 'Unknown';
  }
  if (normalized === 'mac') return 'macOS';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

export const parseSemver = (version: string): ParsedSemver | null => {
  if (!version) return null;
  const cleaned = version.trim().replace(/^v/i, '');
  const [withoutBuild] = cleaned.split('+');
  const dashIndex = withoutBuild.indexOf('-');
  const core =
    dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex);
  const prereleasePart =
    dashIndex === -1 ? '' : withoutBuild.slice(dashIndex + 1);
  const parts = core.split('.');
  if (parts.length < 3) return null;

  const [majorStr, minorStr, patchStr] = parts;
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const patch = Number(patchStr);

  if ([major, minor, patch].some((value) => Number.isNaN(value))) {
    return null;
  }

  const prerelease = prereleasePart
    ? prereleasePart.split('.').filter(Boolean)
    : [];

  return {
    major,
    minor,
    patch,
    prerelease,
    raw: cleaned,
  };
};

const comparePrerelease = (a: string[], b: string[]): number => {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const aId = a[i];
    const bId = b[i];

    if (aId === undefined && bId === undefined) return 0;
    if (aId === undefined) return -1; // shorter prerelease is lower precedence
    if (bId === undefined) return 1;

    const aNum = Number(aId);
    const bNum = Number(bId);
    const aIsNum = !Number.isNaN(aNum) && aId.trim() !== '';
    const bIsNum = !Number.isNaN(bNum) && bId.trim() !== '';

    if (aIsNum && bIsNum) {
      if (aNum > bNum) return 1;
      if (aNum < bNum) return -1;
      continue;
    }

    if (aIsNum && !bIsNum) return -1;
    if (!aIsNum && bIsNum) return 1;

    if (aId > bId) return 1;
    if (aId < bId) return -1;
  }

  return 0;
};

export const compareSemver = (a: string, b: string): number => {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);

  if (!parsedA || !parsedB) return 0;

  if (parsedA.major !== parsedB.major) {
    return parsedA.major > parsedB.major ? 1 : -1;
  }

  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor > parsedB.minor ? 1 : -1;
  }

  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch > parsedB.patch ? 1 : -1;
  }

  const normalizePrerelease = (value: string[]): string[] => {
    if (value.length === 0) return value;
    const first = value[0]?.toLowerCase();
    if (first && STABLE_CHANNELS.has(first)) {
      return [];
    }
    return value;
  };

  const aPre = normalizePrerelease(parsedA.prerelease);
  const bPre = normalizePrerelease(parsedB.prerelease);

  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  return comparePrerelease(aPre, bPre);
};

export const getPrereleaseChannel = (version: string): string | null => {
  const parsed = parseSemver(version);
  if (!parsed || parsed.prerelease.length === 0) return null;
  const channel = parsed.prerelease[0];
  if (!channel) return null;

  const lower = channel.toLowerCase();
  if (STABLE_CHANNELS.has(lower)) {
    return null;
  }

  return channel;
};

export interface ReleaseTagInfo {
  tag: string;
  version: string;
  platform: AppPlatform;
}

export const parseReleaseTag = (tag: string): ReleaseTagInfo | null => {
  if (!tag) return null;
  const cleaned = tag.replace(/^refs\/tags\//, '').replace(/^v/i, '');
  const parts = cleaned.split('-');
  if (parts.length < 2) return null;

  const platformPart = parts[parts.length - 1];
  const version = parts.slice(0, -1).join('-');
  const platform = normalizePlatform(platformPart);

  if (!platform || !parseSemver(version)) return null;

  return {
    tag: `v${version}-${platform}`,
    version,
    platform,
  };
};

export const isPrereleaseVersion = (version: string): boolean => {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  return parsed.prerelease.length > 0 && getPrereleaseChannel(version) !== null;
};
