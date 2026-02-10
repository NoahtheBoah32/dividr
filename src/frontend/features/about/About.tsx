import releaseMetaFallback from '@/frontend/assets/releaseMetaFallback.json';
import { Button } from '@/frontend/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/frontend/components/ui/dialog';
import { ScrollArea } from '@/frontend/components/ui/scroll-area';
import type {
  ReleaseDetails,
  ReleaseUpdateCache,
} from '@/shared/types/release';
import { formatPlatformLabel, normalizePlatform } from '@/shared/utils/release';
import { Info, RefreshCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import packageJson from '../../../../package.json';

const APP_NAME = 'DiviDr';
const APP_VERSION = packageJson.version || '0.0.0';

const AUTO_CHECK_FOR_UPDATES = false;

const detectPlatformFromUA = (): string | null => {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac/i.test(ua)) return 'mac';
  if (/Linux/i.test(ua)) return 'linux';
  return null;
};

const formatTimestamp = (value?: string | null): string => {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return date.toLocaleString();
};

const toIsoOrNull = (value?: string | null): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const FALLBACK_RELEASE_DETAILS: ReleaseDetails = {
  tag: releaseMetaFallback.releaseTag || `v${APP_VERSION}-local`,
  title: releaseMetaFallback.title || 'Development Build',
  notes:
    releaseMetaFallback.notes || 'Release notes are available when online.',
  publishedAt: toIsoOrNull(releaseMetaFallback.buildDate),
  commit: releaseMetaFallback.commit || null,
};

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  const [releaseDetails, setReleaseDetails] = useState<ReleaseDetails | null>(
    null,
  );
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [updateCache, setUpdateCache] = useState<ReleaseUpdateCache | null>(
    null,
  );
  const [isChecking, setIsChecking] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<boolean | null>(null);
  const [updateStatusMessage, setUpdateStatusMessage] = useState<string | null>(
    null,
  );

  const platformLabel = useMemo(() => {
    const normalized = normalizePlatform(detectPlatformFromUA());
    if (normalized) {
      return formatPlatformLabel(normalized);
    }
    return formatPlatformLabel(detectPlatformFromUA() ?? 'Unknown');
  }, []);

  const loadReleaseDetails = useCallback(async () => {
    setReleaseLoading(true);
    try {
      const result = await window.electronAPI.releaseGetInstalledRelease();
      if (result.success && result.release) {
        setReleaseDetails(result.release);
      } else {
        setReleaseDetails(FALLBACK_RELEASE_DETAILS);
        if (result.errorCode === 'rate_limited') {
          setUpdateStatusMessage(
            'Update check temporarily unavailable. Using last known release information.',
          );
        }
      }
    } catch (error) {
      console.warn('[About] Failed to load release details', error);
      setReleaseDetails(FALLBACK_RELEASE_DETAILS);
    } finally {
      setReleaseLoading(false);
    }
  }, []);

  const loadUpdateCache = useCallback(async () => {
    try {
      const cache = await window.electronAPI.releaseGetUpdateCache();
      setUpdateCache(cache);
    } catch (error) {
      console.warn('[About] Failed to load update cache', error);
    }
  }, []);

  const handleCheckUpdates = useCallback(async () => {
    if (isChecking) return;
    setIsChecking(true);

    try {
      const result = await window.electronAPI.releaseCheckForUpdates();
      if (result.latest) {
        setUpdateCache(result.latest);
      }
      if (typeof result.updateAvailable === 'boolean') {
        setUpdateAvailable(result.updateAvailable);
      }

      if (result.errorCode === 'rate_limited') {
        setUpdateStatusMessage(
          'Update check temporarily unavailable. Using last known release information.',
        );
        return;
      }

      if (result.success) {
        setUpdateStatusMessage(null);
        if (result.updateAvailable && result.latest?.latestVersion) {
          toast.info(`Update available: v${result.latest.latestVersion}`, {
            description: result.latest.latestTitle,
          });
        } else if (!result.updateAvailable) {
          toast.success('DiviDr is up to date');
        }
      }
    } catch (error) {
      console.warn('[About] Update check failed', error);
    } finally {
      setIsChecking(false);
    }
  }, [isChecking]);

  useEffect(() => {
    if (!open) return;
    loadReleaseDetails();
    loadUpdateCache();
  }, [loadReleaseDetails, loadUpdateCache, open]);

  useEffect(() => {
    if (!AUTO_CHECK_FOR_UPDATES || !open) return;
    handleCheckUpdates();
  }, [handleCheckUpdates, open]);

  const releaseTitle = releaseDetails?.title || 'Release details unavailable';
  const releaseNotes = releaseDetails?.notes?.trim()
    ? releaseDetails.notes
    : releaseLoading
      ? 'Loading release notes...'
      : 'Release notes are available when online.';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1200px] min-w-[40vw] max-h-[90vh] p-0 flex flex-col">
        <DialogHeader className="px-8 py-5 border-b border-border/50 bg-gradient-to-b from-muted/30 to-background">
          <DialogTitle className="flex items-center gap-4">
            <div className="p-2.5 bg-primary/15 rounded-xl ring-1 ring-primary/20">
              <Info className="h-6 w-6 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-4">
                <h2 className="text-2xl font-bold tracking-tight">
                  About {APP_NAME}
                </h2>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="inline-flex items-center rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs font-semibold text-foreground/80">
                    v{APP_VERSION}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs font-semibold text-foreground/80">
                    {platformLabel}
                  </span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mt-0.5 font-normal">
                Release notes and build information
              </p>
            </div>
          </DialogTitle>
          <div className="text-sm text-muted-foreground mt-2">
            {releaseTitle}
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1 px-8 py-0 overflow-y-auto min-h-0">
          <div className="grid gap-6 grid-rows-[2fr_1fr]">
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="font-semibold text-xs text-muted-foreground/80 uppercase tracking-wide pb-1">
                Release Notes
              </div>
              <div className="rounded-xl min-h-0 border border-border/60 bg-card px-5 py-4 shadow-sm">
                <div className="space-y-4 text-sm leading-6 text-foreground/90">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => (
                        <h1 className="text-lg font-semibold text-foreground">
                          {children}
                        </h1>
                      ),
                      h2: ({ children }) => (
                        <h2 className="text-base font-semibold text-foreground">
                          {children}
                        </h2>
                      ),
                      h3: ({ children }) => (
                        <h3 className="text-sm font-semibold text-foreground">
                          {children}
                        </h3>
                      ),
                      p: ({ children }) => (
                        <p className="text-sm leading-6 text-foreground/90">
                          {children}
                        </p>
                      ),
                      ul: ({ children }) => (
                        <ul className="list-disc space-y-2 pl-5">{children}</ul>
                      ),
                      ol: ({ children }) => (
                        <ol className="list-decimal space-y-2 pl-5">
                          {children}
                        </ol>
                      ),
                      li: ({ children }) => (
                        <li className="text-sm leading-6 text-foreground/90">
                          {children}
                        </li>
                      ),
                      code: ({ children }) => (
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/90">
                          {children}
                        </code>
                      ),
                      a: ({ children, href }) => (
                        <a
                          className="text-secondary underline underline-offset-4"
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {releaseNotes}
                  </ReactMarkdown>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-border/60 bg-card px-5 py-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      Updates
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Manual check (online)
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleCheckUpdates}
                    disabled={isChecking}
                  >
                    {isChecking ? 'Checking…' : 'Check'}
                  </Button>
                </div>

                <div className="mt-3 space-y-2 text-sm text-foreground/80">
                  {updateStatusMessage && (
                    <div className="text-xs text-muted-foreground">
                      {updateStatusMessage}
                    </div>
                  )}

                  {updateAvailable === true && updateCache && (
                    <div className="rounded-md border border-secondary/40 bg-secondary/10 px-3 py-2 text-sm text-foreground">
                      Update available: v{updateCache.latestVersion}
                    </div>
                  )}

                  {updateAvailable === false && (
                    <div className="text-sm text-muted-foreground">
                      You are on the latest version for your channel.
                    </div>
                  )}

                  {updateCache && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">
                          Latest Tag
                        </span>
                        <span className="font-mono text-xs text-foreground/80">
                          {updateCache.latestTag}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">
                          Latest Title
                        </span>
                        <span className="text-right text-xs text-foreground/80">
                          {updateCache.latestTitle}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">
                          Last Checked
                        </span>
                        <span className="text-xs text-foreground/80">
                          {formatTimestamp(updateCache.checkedAt)}
                        </span>
                      </div>
                    </div>
                  )}

                  {!updateCache && (
                    <div className="text-xs text-muted-foreground">
                      No update check has been performed yet.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>

        <div className="px-8 py-4 border-t border-border/50 bg-muted/10 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Tip:</span>
            <span>Release notes update when online.</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs gap-2"
              onClick={loadReleaseDetails}
              disabled={releaseLoading}
            >
              <RefreshCcw className="h-3.5 w-3.5" />
              {releaseLoading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
