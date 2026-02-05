/* eslint-disable @typescript-eslint/no-explicit-any */
import { createContext, useContext, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light' | 'system' | 'soft-dark';

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: Exclude<Theme, 'system'>;
  setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: 'system',
  resolvedTheme: 'soft-dark',
  setTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'vite-ui-theme',
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(storageKey) as Theme | null;
    if (
      stored === 'dark' ||
      stored === 'light' ||
      stored === 'system' ||
      stored === 'soft-dark'
    ) {
      return stored;
    }
    return defaultTheme;
  });
  const [resolvedTheme, setResolvedTheme] = useState<Exclude<Theme, 'system'>>(
    () => {
      if (typeof window === 'undefined') {
        if (defaultTheme === 'light') return 'light';
        if (defaultTheme === 'dark') return 'dark';
        return 'soft-dark';
      }
      const prefersDark = window.matchMedia(
        '(prefers-color-scheme: dark)',
      ).matches;
      if (theme === 'system') {
        return prefersDark ? 'soft-dark' : 'light';
      }
      return theme === 'dark' || theme === 'soft-dark' ? theme : 'light';
    },
  );

  useEffect(() => {
    const root = window.document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const resolveTheme = () => {
      if (theme === 'system') {
        return media.matches ? 'soft-dark' : 'light';
      }
      return theme;
    };

    const resolveCssColor = (hslValue: string, fallback: string): string => {
      if (!hslValue) return fallback;
      const body = document.body;
      if (!body) return fallback;
      const swatch = document.createElement('span');
      swatch.style.color = `hsl(${hslValue})`;
      swatch.style.position = 'absolute';
      swatch.style.opacity = '0';
      swatch.style.pointerEvents = 'none';
      body.appendChild(swatch);
      const color = getComputedStyle(swatch).color || fallback;
      body.removeChild(swatch);
      return color;
    };

    const isTitlebarReady = () =>
      typeof window !== 'undefined' && (window as any).__titlebarReady === true;

    const applyTitlebarOverlay = (activeTheme: Theme) => {
      const isWindows =
        typeof navigator !== 'undefined' &&
        /Windows/i.test(navigator.userAgent || '');
      if (!isWindows) return;

      const isDarkTheme = activeTheme === 'dark' || activeTheme === 'soft-dark';
      const isPreviewFullscreen = root.dataset.previewFullscreen === 'true';
      const styles = getComputedStyle(root);
      const background = styles.getPropertyValue('--background').trim();
      const foreground = styles.getPropertyValue('--foreground').trim();

      const color = isPreviewFullscreen
        ? '#000000'
        : resolveCssColor(background, isDarkTheme ? '#09090b' : '#ffffff');
      const symbolColor = isPreviewFullscreen
        ? '#000000'
        : resolveCssColor(foreground, isDarkTheme ? '#ffffff' : '#111111');
      const effectiveSymbolColor = isPreviewFullscreen
        ? '#000000'
        : isTitlebarReady()
          ? symbolColor
          : color;

      window.appControl?.setTitlebarOverlay?.({
        color,
        symbolColor: effectiveSymbolColor,
      });
    };

    const applyTheme = () => {
      const activeTheme = resolveTheme() as Exclude<Theme, 'system'>;
      setResolvedTheme(activeTheme);
      root.classList.remove('light', 'dark', 'soft-dark');
      if (activeTheme === 'light') {
        root.classList.add('light');
      } else if (activeTheme === 'dark') {
        root.classList.add('dark');
      } else if (activeTheme === 'soft-dark') {
        root.classList.add('dark', 'soft-dark');
      }
      requestAnimationFrame(() => applyTitlebarOverlay(activeTheme));
    };

    applyTheme();

    const handleTitlebarReady = () => {
      applyTitlebarOverlay(resolveTheme() as Theme);
    };
    window.addEventListener('titlebar-ready', handleTitlebarReady);

    if (theme === 'system') {
      const handleChange = () => applyTheme();
      if (media.addEventListener) {
        media.addEventListener('change', handleChange);
        return () => {
          media.removeEventListener('change', handleChange);
          window.removeEventListener('titlebar-ready', handleTitlebarReady);
        };
      }
      media.addListener?.(handleChange);
      return () => {
        media.removeListener?.(handleChange);
        window.removeEventListener('titlebar-ready', handleTitlebarReady);
      };
    }

    return () => {
      window.removeEventListener('titlebar-ready', handleTitlebarReady);
    };
  }, [theme]);

  const value = {
    theme,
    resolvedTheme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme);
      setTheme(theme);
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error('useTheme must be used within a ThemeProvider');

  return context;
};
