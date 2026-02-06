export type AppPlatform = 'windows' | 'mac' | 'linux';

export interface ReleaseMetadata {
  appName: string;
  version: string;
  platform: AppPlatform | string;
  releaseTag: string;
  title: string;
  notes: string;
  commit: string;
  buildDate: string;
}

export interface ReleaseDetails {
  tag: string;
  title: string;
  notes: string;
  publishedAt: string | null;
  commit: string | null;
}

export interface ReleaseDetailsResult {
  success: boolean;
  release?: ReleaseDetails;
  error?: string;
  errorCode?: 'rate_limited' | 'network' | 'api_error';
  rateLimitResetAt?: string | null;
}

export interface ReleaseUpdateCache {
  latestVersion: string;
  latestTag: string;
  latestTitle: string;
  checkedAt: string;
}

export interface ReleaseUpdateCheckResult {
  success: boolean;
  updateAvailable: boolean;
  installedVersion: string;
  installedTag: string;
  latest?: ReleaseUpdateCache;
  error?: string;
  errorCode?: 'rate_limited' | 'network' | 'api_error';
  rateLimitResetAt?: string | null;
}
