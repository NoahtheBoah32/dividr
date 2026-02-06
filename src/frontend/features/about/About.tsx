import { Button } from '@/frontend/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/frontend/components/ui/dialog';
import { ScrollArea } from '@/frontend/components/ui/scroll-area';
import type {
  ReleaseDetails,
  ReleaseUpdateCache,
} from '@/shared/types/release';
import { formatPlatformLabel, normalizePlatform } from '@/shared/utils/release';
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
        setReleaseDetails(null);
      }
    } catch (error) {
      console.warn('Failed to load release details:', error);
      setReleaseDetails(null);
    } finally {
      setReleaseLoading(false);
    }
  }, []);

  const loadUpdateCache = useCallback(async () => {
    try {
      const cache = await window.electronAPI.releaseGetUpdateCache();
      setUpdateCache(cache);
    } catch (error) {
      console.warn('Failed to load update cache:', error);
    }
  }, []);

  const handleCheckUpdates = useCallback(async () => {
    if (isChecking) return;
    setIsChecking(true);

    try {
      const result = await window.electronAPI.releaseCheckForUpdates();
      if (result.success) {
        if (result.latest) {
          setUpdateCache(result.latest);
        }
        setUpdateAvailable(result.updateAvailable);

        if (result.updateAvailable && result.latest?.latestVersion) {
          toast.info(`Update available: v${result.latest.latestVersion}`, {
            description: result.latest.latestTitle,
          });
        } else if (!result.updateAvailable) {
          toast.success('DiviDr is up to date');
        }
      }
    } catch (error) {
      console.warn('Update check failed:', error);
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
      <DialogContent className="h-[min(85vh,900px)] w-[min(1000px,92vw)] max-w-5xl p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>About DiviDr</DialogTitle>
          <DialogDescription>
            Release notes and build information.
          </DialogDescription>
        </DialogHeader>
        <div className="flex h-full min-h-0 flex-col">
          <header className="border-b rounded-t-lg border-border/60 bg-card px-6 py-5">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {APP_NAME}
                </h1>
                <span className="inline-flex items-center rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-sm font-medium text-foreground/80">
                  v{APP_VERSION}
                </span>
                <span className="inline-flex items-center rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-sm font-medium text-foreground/80">
                  {platformLabel}
                </span>
              </div>
              <div className="text-sm text-muted-foreground">
                {releaseTitle}
              </div>
            </div>
          </header>

          <section className="grid overflow-y-auto flex-1 min-h-0 gap-6 px-6 pb-6 pt-4 grid-rows-[2fr_1fr]">
            <div className="flex min-h-0 flex-col gap-3">
              <div className="text-sm font-semibold text-foreground">
                Release Notes
              </div>
              <ScrollArea className="flex-1 rounded-xl border border-border/60 bg-card px-5 py-4 shadow-sm">
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
              </ScrollArea>
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
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
