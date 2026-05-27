/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ProjectNameInput Component
 * A specialized input component for editing project names
 * Used in the titlebar of the video editor
 */
import { Input } from '@/frontend/components/ui/input';
import { useProjectStore } from '@/frontend/features/projects/store/projectStore';
import { cn } from '@/frontend/utils/utils';
import { ChevronDown } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useVideoEditorStore } from '../../stores/videoEditor';

interface ProjectNameInputProps {
  className?: string;
  placeholder?: string;
}

const ProjectNameInput: React.FC<ProjectNameInputProps> = ({
  className = '',
  placeholder = 'Untitled Project',
}) => {
  const {
    currentProject,
    updateCurrentProjectMetadata,
    saveCurrentProject,
    isLoading,
  } = useProjectStore();
  const { isSaving: isVideoEditorSaving } = useVideoEditorStore();

  const [localTitle, setLocalTitle] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const animFrameRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update local title when current project changes (skip during animation)
  useEffect(() => {
    if (isAnimating) return;
    if (currentProject) {
      setLocalTitle(currentProject.metadata.title);
    } else {
      setLocalTitle('');
    }
  }, [currentProject, isAnimating]);

  // EDITH typewriter rename animation
  useEffect(() => {
    const handler = (e: Event) => {
      const { title } = (e as CustomEvent<{ title: string }>).detail;
      if (!title?.trim()) return;
      if (animFrameRef.current) clearTimeout(animFrameRef.current);
      setIsAnimating(true);
      setLocalTitle('');
      let i = 0;
      const tick = () => {
        i += 1;
        setLocalTitle(title.slice(0, i));
        if (i < title.length) {
          animFrameRef.current = setTimeout(tick, 65);
        } else {
          setIsAnimating(false);
          updateCurrentProjectMetadata({ title });
          saveCurrentProject().catch(() => {});
        }
      };
      animFrameRef.current = setTimeout(tick, 120);
    };
    window.addEventListener('edith:renameProject', handler);
    return () => {
      window.removeEventListener('edith:renameProject', handler);
      if (animFrameRef.current) clearTimeout(animFrameRef.current);
    };
  }, [updateCurrentProjectMetadata, saveCurrentProject]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTitle = e.target.value;
    setLocalTitle(newTitle);

    if (currentProject && newTitle !== currentProject.metadata.title) {
      updateCurrentProjectMetadata({ title: newTitle });
    }

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Set new timeout to save after 1 second of no typing
    if (
      currentProject &&
      newTitle.trim() &&
      newTitle !== currentProject.metadata.title
    ) {
      saveTimeoutRef.current = setTimeout(async () => {
        console.log('Auto-saving project with title:', newTitle);
        setIsSaving(true);
        try {
          await saveCurrentProject();
          console.log('Project saved successfully');
        } catch (error) {
          console.error('Failed to auto-save project:', error);
          toast.error('Failed to save project');
        } finally {
          setIsSaving(false);
        }
      }, 1000);
    }
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  if (!currentProject) {
    return (
      <div className="text-sm text-zinc-500 dark:text-zinc-400 px-2 py-1">
        No project loaded
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <Input
          className={cn(
            'border-none text-sm !pl-0 h-6 pe-9 !bg-transparent focus-visible:ring-0 min-w-[114px] max-w-[135px] focus-visible:ring-offset-0 focus-visible:outline-none ring-0 rounded-md',
            isSaving && 'text-secondary',
            isAnimating && 'caret-transparent select-none',
            className,
          )}
          placeholder={placeholder}
          value={localTitle}
          onChange={handleChange}
          disabled={isLoading || isSaving || isAnimating}
          readOnly={isAnimating}
        />
        {isAnimating ? (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 inline-block w-[1.5px] h-[11px] bg-zinc-300 animate-pulse rounded-sm" />
        ) : (
          <ChevronDown
            className="absolute right-2 top-1/2 -translate-y-1/2"
            size={12}
          />
        )}
      </div>

      {!isAnimating && (isSaving || isVideoEditorSaving) && (
        <div className="text-xs text-secondary px-2">Saving...</div>
      )}
    </div>
  );
};

export { ProjectNameInput };
