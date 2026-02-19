import { useTheme } from '@/frontend/providers/ThemeProvider';
import { Toaster as Sonner, ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
  const { className, style, ...restProps } = props;
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
      {...restProps}
      theme={sonnerTheme as ToasterProps['theme']}
      className={['toaster group', className].filter(Boolean).join(' ')}
      style={
        {
          '--normal-bg': 'hsl(var(--popover))',
          '--normal-text': 'hsl(var(--popover-foreground))',
          '--normal-border': 'hsl(var(--border))',
          '--border-radius': '4px',
          ...style,
        } as React.CSSProperties
      }
    />
  );
};

export { Toaster };
