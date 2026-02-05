import { useTheme } from '@/frontend/providers/ThemeProvider';
import { Toaster as Sonner, ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system', resolvedTheme } = useTheme();
  const sonnerTheme =
    theme === 'soft-dark'
      ? 'dark'
      : theme === 'system'
        ? resolvedTheme === 'light'
          ? 'light'
          : 'dark'
        : theme;

  return (
    <Sonner
      theme={sonnerTheme as ToasterProps['theme']}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
