/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A custom React fixed component
 * A Fixed element in the header portion of Downlodr, displays the title/logo of Downlodr with the window controls (maximize, minimize, and close)
 *
 * @param className - for UI of TitleBar
 * @returns JSX.Element - The rendered component displaying a TitleBar
 *
 */
import LogoDark from '@/frontend/assets/logo/Logo-Dark.svg';
import LogoLight from '@/frontend/assets/logo/Logo-Light.svg';
import { ModeToggle } from '@/frontend/components/custom/ModeToggle';
import { Button, buttonVariants } from '@/frontend/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/frontend/components/ui/dropdown-menu';
import { useProjectStore } from '@/frontend/features/projects/store/projectStore';
import { useTheme } from '@/frontend/providers/ThemeProvider';
import { cn } from '@/frontend/utils/utils';
import { Minus, Plus, Square, Upload, X } from 'lucide-react';
import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import packageJson from '../../../package.json';
import { AutosaveIndicator } from '../features/editor/components/autoSaveIndicator';
interface TitleBarProps {
  className?: string;
}

const VersionBadge: React.FC = () => {
  return (
    <span className="text-xs text-muted-foreground font-medium px-2 py-0.5 rounded-md bg-muted/50">
      v{packageJson.version}
    </span>
  );
};

const TitleBar: React.FC<TitleBarProps> = ({ className }) => {
  const { createNewProject, openProject, importProject } = useProjectStore();
  const { theme, resolvedTheme } = useTheme();
  const { projects } = useProjectStore();

  const location = useLocation();

  const navigate = useNavigate();
  const isWindows =
    typeof navigator !== 'undefined' &&
    /Windows/i.test(navigator.userAgent || '');
  const isDev = (import.meta as any).env?.DEV === true;
  const titlebarRef = React.useRef<HTMLDivElement>(null);

  // Determine context based on current route
  const isInVideoEditor = location.pathname.startsWith('/video-editor');

  const handleCreateProject = async () => {
    try {
      const projectId = await createNewProject('Untitled Project');

      // Open the newly created project to set it as current
      await openProject(projectId);

      // Navigate to video editor with the new project
      navigate('/video-editor');
    } catch (error) {
      console.error('Failed to create project:', error);
      // Could add toast notification here if needed
    }
  };

  const handleImportProject = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      await importProject(file);
      toast.success('Project imported successfully!');
    } catch (error) {
      console.error('Failed to import project:', error);
      toast.error('Failed to import project');
    }

    // Reset the input
    event.target.value = '';
  };

  // Function to toggle maximize/restore
  const handleMaximizeRestore = () => {
    window.appControl.maximizeApp();
  };

  // Handle close button click
  const handleCloseClick = () => {
    window.appControl.quitApp();
  };

  React.useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.titlebarReady !== 'true') {
      root.dataset.titlebarReady = 'false';
    }

    const rafIds: number[] = [];
    rafIds.push(
      requestAnimationFrame(() => {
        rafIds.push(
          requestAnimationFrame(() => {
            (window as any).__titlebarReady = true;
            root.dataset.titlebarReady = 'true';
            window.dispatchEvent(new Event('titlebar-ready'));
          }),
        );
      }),
    );

    return () => {
      rafIds.forEach((id) => cancelAnimationFrame(id));
    };
  }, []);

  React.useEffect(() => {
    if (!isWindows || !window.appControl?.setTitlebarOverlay) return;
    const element = titlebarRef.current;
    if (!element) return;

    let lastHeight = 0;
    const updateHeight = () => {
      const nextHeight = Math.max(
        1,
        Math.round(element.getBoundingClientRect().height),
      );
      if (nextHeight === lastHeight) return;
      lastHeight = nextHeight;
      window.appControl?.setTitlebarOverlay?.({ height: nextHeight });
    };

    updateHeight();

    const rafId = requestAnimationFrame(() => updateHeight());

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateHeight());
      observer.observe(element);
    }

    const handleRefresh = () => {
      lastHeight = 0;
      updateHeight();
    };
    window.addEventListener('resize', updateHeight);
    window.addEventListener('titlebar-height-refresh', handleRefresh);

    return () => {
      window.removeEventListener('resize', updateHeight);
      window.removeEventListener('titlebar-height-refresh', handleRefresh);
      observer?.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, [isWindows]);

  // Adjust downlodr logo used depending on the light/dark mode
  /*
  const getLogoSrc = () => {
    if (theme === 'system') {
      // Check system preference
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? downlodrLogoDark
        : downlodrLogoLight;
    }
    // Direct theme selection
    return theme === 'dark' ? downlodrLogoDark : downlodrLogoLight;
  };
  */
  return (
    <>
      <div ref={titlebarRef} className={cn('', className)}>
        <div className="relative flex items-center h-8 drag-area titlebar-safe-area">
          {/* Logo */}
          <div className="flex gap-2 items-center no-drag">
            <Link to="/" className="cursor-pointer">
              <img
                src={
                  (theme === 'system' ? resolvedTheme : theme) !== 'light'
                    ? LogoDark
                    : LogoLight
                }
                className="h-10 w-auto"
                alt="Dividr Logo"
              />
            </Link>
            {!isInVideoEditor && <VersionBadge />}

            {isInVideoEditor && <AutosaveIndicator />}
          </div>

          {/* Right Side Controls */}
          <div className="flex items-center gap-7 no-drag text-foreground ml-auto">
            {/* New Project Button - Only show when not in video editor */}
            {!isInVideoEditor && projects.length !== 0 && (
              <div className="flex items-center gap-2">
                <label
                  className={cn(
                    'cursor-pointer',
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                  )}
                >
                  <Upload size={16} />
                  Import
                  <input
                    type="file"
                    accept=".dividr,.json"
                    onChange={handleImportProject}
                    className="hidden"
                  />
                </label>
                <Button
                  onClick={handleCreateProject}
                  variant="secondary"
                  size="sm"
                >
                  <Plus size={16} /> New Project
                </Button>
              </div>
            )}

            {/* Dark Mode/Light Mode Toggle */}
            <div className="flex items-center gap-7">
              {/* Test Tools - Only show in development */}
              {isDev && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="gap-1">
                      Dev Tools
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link to="/dev-tools">Media Tools</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link to="/dialogs-test">Dialogs Showcase</Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {isInVideoEditor && <VersionBadge />}
              <ModeToggle />
            </div>

            {/* Window Controls */}
            {!isWindows && (
              <div className="titlebar-controls flex items-center gap-4">
                {/* Minimize Button */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => window.appControl.minimizeApp()}
                  title="Minimize"
                  className="rounded-md hover:bg-gray-100 dark:hover:bg-zinc-700 hover:opacity-100 !p-1 size-fit"
                >
                  <Minus size={16} />
                </Button>

                {/* Maximize Button */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleMaximizeRestore}
                  title="Maximize"
                  className="rounded-md hover:bg-gray-100 dark:hover:bg-zinc-700 hover:opacity-100 !p-1 size-fit"
                >
                  <Square size={16} />
                </Button>

                {/* Close Button */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCloseClick}
                  title="Close"
                  className="rounded-md hover:bg-red-600 dark:hover:bg-red-600 hover:text-zinc-100 !p-1 size-fit"
                >
                  <X size={16} />
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default TitleBar;
