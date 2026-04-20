import LogoDark from '@/frontend/assets/logo/New-Dark.svg';
import Logo from '@/frontend/assets/logo/New-Light.svg';
import { useTheme } from '@/frontend/providers/ThemeProvider';
import { StartupStage } from '@/frontend/utils/startupManager';
import { useEffect, useState } from 'react';

interface StartupLoaderProps {
  stage?: StartupStage;
  progress?: number;
  isVisible?: boolean;
}

/**
 * StartupLoader Component
 *
 * Displays a branded loading screen during app initialization.
 * Shows immediately on app launch before React fully mounts.
 */
const StartupLoader = ({
  stage = 'renderer-mount',
  progress,
  isVisible = true,
}: StartupLoaderProps) => {
  const { theme, resolvedTheme } = useTheme();
  const isDarkTheme = (theme === 'system' ? resolvedTheme : theme) !== 'light';
  const [dots, setDots] = useState('');

  // Animated dots effect
  useEffect(() => {
    if (!isVisible) return;

    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
    }, 500);

    return () => clearInterval(interval);
  }, [isVisible]);

  if (!isVisible) return null;

  const activeStep =
    stage === 'indexeddb-init' ||
    stage === 'indexeddb-ready' ||
    stage === 'projects-loading' ||
    stage === 'projects-loaded'
      ? 1
      : 0;

  return (
    <div className="fixed bottom-6 left-6 z-50 pointer-events-none">
      <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-background/90 px-4 py-3 shadow-lg backdrop-blur">
        <img
          src={isDarkTheme ? LogoDark : Logo}
          alt="Dividr"
          className="w-10 h-10"
        />
        <div className="flex flex-col gap-1 min-w-[260px]">
          <div className="text-sm font-medium text-foreground">
            Initializing DiviDr.
            <span className="inline-block w-6 text-left">{dots}</span>
          </div>
          <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span
                className={
                  activeStep === 0 ? 'text-foreground' : 'text-zinc-500'
                }
              >
                •
              </span>
              <span
                className={
                  activeStep === 0 ? 'text-foreground' : 'text-zinc-500'
                }
              >
                Preparing your workspace
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={
                  activeStep === 1 ? 'text-foreground' : 'text-zinc-500'
                }
              >
                •
              </span>
              <span
                className={
                  activeStep === 1 ? 'text-foreground' : 'text-zinc-500'
                }
              >
                Loading your projects and workspace data
              </span>
            </div>
          </div>

          {progress !== undefined && (
            <div className="mt-1 h-1 w-full rounded-full bg-zinc-200/60 dark:bg-zinc-800/60 overflow-hidden">
              <div
                className="h-full bg-zinc-900 dark:bg-zinc-100 transition-all duration-300 ease-out"
                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StartupLoader;
