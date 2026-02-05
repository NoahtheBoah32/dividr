import { Button } from '@/frontend/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/frontend/components/ui/dropdown-menu';
import { Theme, useTheme } from '@/frontend/providers/ThemeProvider';
import { Monitor, MoonIcon, SunIcon } from 'lucide-react';

export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const icon =
    theme === 'light' ? (
      <SunIcon size={16} />
    ) : theme === 'system' ? (
      <Monitor size={16} />
    ) : (
      <MoonIcon size={16} />
    );

  return (
    <div className="flex items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="!size-7 !p-1.5 hover:!bg-transparent"
            aria-label="Change theme"
          >
            {icon}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            value={theme}
            onValueChange={(value) => setTheme(value as Theme)}
          >
            <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="soft-dark">
              Soft Dark
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
