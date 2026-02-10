import { Kbd, KbdGroup } from '@/frontend/components/ui/kbd';
import { cn } from '@/frontend/utils/utils';
import React, { useMemo } from 'react';
import { getDisplayKeyGroups } from './shortcutUtils';

interface ShortcutKbdStackProps {
  combos: string[];
  className?: string;
  groupClassName?: string;
  kbdClassName?: string;
  maxCombos?: number;
}

export const ShortcutKbdStack: React.FC<ShortcutKbdStackProps> = ({
  combos,
  className,
  groupClassName,
  kbdClassName,
  maxCombos,
}) => {
  const displayGroups = useMemo(() => getDisplayKeyGroups(combos), [combos]);
  const groups = maxCombos
    ? displayGroups.slice(0, Math.max(0, maxCombos))
    : displayGroups;

  if (groups.length === 0) return null;

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {groups.map((group, groupIndex) => (
        <React.Fragment key={`${groupIndex}-${group.join('-')}`}>
          <KbdGroup className={groupClassName}>
            {group.map((token, tokenIndex) => (
              <Kbd key={`${token}-${tokenIndex}`} className={kbdClassName}>
                {token}
              </Kbd>
            ))}
          </KbdGroup>
          {groupIndex < groups.length - 1 && (
            <span className="text-muted-foreground text-xs select-none">/</span>
          )}
        </React.Fragment>
      ))}
    </span>
  );
};
