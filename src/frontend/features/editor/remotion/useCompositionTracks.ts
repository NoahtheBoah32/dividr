/**
 * Converts Dividr's Zustand timeline tracks into the flat CompositionTrack[]
 * that MyceliumComposition consumes. Handles source URL normalization for Electron.
 */

import { useMemo } from 'react';
import { useVideoEditorStore } from '../stores/videoEditor';
import { CompositionTrack } from './MyceliumComposition';

function toFileUrl(source: string): string {
  if (!source) return '';
  if (source.startsWith('blob:') || source.startsWith('http')) return source;
  // Convert Windows backslashes and ensure file:// prefix
  const normalized = source.replace(/\\/g, '/');
  if (normalized.startsWith('file://')) return normalized;
  return `file:///${normalized.replace(/^\//, '')}`;
}

export function useCompositionTracks(): CompositionTrack[] {
  const tracks = useVideoEditorStore((s) => s.tracks);

  return useMemo(
    () =>
      tracks
        .filter((t) => t.visible !== false)
        .map((t) => ({
          id: t.id,
          type: t.type as CompositionTrack['type'],
          // Prefer previewUrl (blob) over raw source path for browser access
          source: toFileUrl((t as any).previewUrl ?? t.source ?? ''),
          startFrame: t.startFrame ?? 0,
          endFrame: t.endFrame ?? 0,
          sourceStartTime: (t as any).sourceStartTime ?? 0,
          visible: t.visible !== false,
          filter: (t as any).filter ?? undefined,
          subtitleText: (t as any).subtitleText ?? undefined,
          subtitleStyle: (t as any).subtitleStyle ?? undefined,
          subtitleTransform: (t as any).subtitleTransform ?? undefined,
        })),
    [tracks],
  );
}
