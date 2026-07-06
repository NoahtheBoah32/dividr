/**
 * Version History — a toolbar button + modal listing the project's auto-saved version
 * snapshots, each restorable. Styled entirely with DiviDr theme tokens (bg-popover,
 * border-border, text-foreground, bg-secondary) so it matches the editor UI automatically.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, RotateCcw, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/frontend/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/frontend/components/ui/tooltip';
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';
import type { ProjectVersion } from '@/backend/services/versionHistoryService';

export const VersionHistoryButton: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const listProjectVersions = useVideoEditorStore((s) => s.listProjectVersions);
  const restoreProjectVersion = useVideoEditorStore((s) => s.restoreProjectVersion);
  const hasProject = useVideoEditorStore((s) => !!s.currentProjectId);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    listProjectVersions()
      .then((v) => {
        if (!cancelled) setVersions(v);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, listProjectVersions]);

  if (!hasProject) return null;

  const handleRestore = async (id: string) => {
    setRestoringId(id);
    try {
      await restoreProjectVersion(id);
      setOpen(false);
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="native" onClick={() => setOpen(true)}>
            <History className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Version history</TooltipContent>
      </Tooltip>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          >
            <div
              className="w-[420px] max-h-[70vh] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div className="flex items-center gap-2">
                  <History className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">Version History</h2>
                </div>
                <button
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="overflow-y-auto px-2 py-2">
                {loading ? (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    Loading versions…
                  </p>
                ) : versions.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    No versions yet. Snapshots are captured automatically as you work.
                  </p>
                ) : (
                  versions.map((v, i) => (
                    <div
                      key={v.id}
                      className="group flex items-center justify-between rounded-md px-3 py-2 hover:bg-accent transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-foreground">
                          {i === 0 ? 'Latest' : formatDistanceToNow(new Date(v.timestamp), { addSuffix: true })}
                        </div>
                        <div className="text-[10px] text-muted-foreground tabular-nums">
                          {new Date(v.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                      <button
                        className="ml-3 flex shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1 text-[11px] font-semibold text-secondary-foreground opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-60"
                        onClick={() => handleRestore(v.id)}
                        disabled={restoringId !== null}
                      >
                        <RotateCcw className="size-3" />
                        {restoringId === v.id ? 'Restoring…' : 'Restore'}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
