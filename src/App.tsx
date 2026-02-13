import { useEffect, useRef, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { toast } from 'sonner';
import { RuntimeDownloadModal } from './frontend/components/custom/RuntimeDownloadModal';
import { RuntimeMissingBanner } from './frontend/components/custom/RuntimeMissingBanner';
import StartupLoader from './frontend/components/custom/StartupLoader';
import { Toaster } from './frontend/components/ui/sonner';
import { useShortcutRegistryInit } from './frontend/features/editor/stores/videoEditor';
import { useProjectStore } from './frontend/features/projects/store/projectStore';
import { RuntimeStatusProvider } from './frontend/providers/RuntimeStatusProvider';
import { ThemeProvider } from './frontend/providers/ThemeProvider';
import { WindowStateProvider } from './frontend/providers/WindowStateProvider';
import { router } from './frontend/routes';
import './frontend/styles/app.css';
import { startupManager, StartupStage } from './frontend/utils/startupManager';

function App() {
  // Initialize shortcut registry globally so it's always available
  useShortcutRegistryInit();

  const [showGlobalDownloadModal, setShowGlobalDownloadModal] = useState(false);
  const [startupStage, setStartupStage] =
    useState<StartupStage>('renderer-mount');
  const [startupProgress, setStartupProgress] = useState(0);
  const [showStartupStatus, setShowStartupStatus] = useState(true);
  const hasRequestedMediaServer = useRef(false);
  const startupHideTimer = useRef<number | null>(null);
  const htmlLoaderRemoved = useRef(false);

  // Get project store actions
  const { importProjectFromPath, openProject, initializeProjects } =
    useProjectStore();

  useEffect(() => {
    const removeHtmlLoader = () => {
      if (htmlLoaderRemoved.current) return;
      const htmlLoader = document.getElementById('startup-loader');
      if (htmlLoader) {
        htmlLoader.remove();
      }
      htmlLoaderRemoved.current = true;
    };

    const scheduleStartupDismiss = (delayMs: number) => {
      if (startupHideTimer.current !== null) {
        window.clearTimeout(startupHideTimer.current);
        startupHideTimer.current = null;
      }

      startupHideTimer.current = window.setTimeout(() => {
        setShowStartupStatus(false);
        removeHtmlLoader();
        startupHideTimer.current = null;
      }, delayMs);
    };

    const unsubscribe = startupManager.subscribe((stage, progress) => {
      setStartupStage(stage);
      setStartupProgress(progress);

      if (stage === 'projects-loaded' || stage === 'editor-ready') {
        scheduleStartupDismiss(250);
      } else if (stage === 'app-ready' && startupHideTimer.current === null) {
        // Safety valve: never let the startup screen stick forever.
        scheduleStartupDismiss(8000);
      }
    });

    const frame = requestAnimationFrame(() => {
      startupManager.logStage('app-ready');
      startupManager.printSummary();

      if (!hasRequestedMediaServer.current) {
        hasRequestedMediaServer.current = true;
        if (window.electronAPI?.ensureMediaServer) {
          void window.electronAPI.ensureMediaServer();
        }
      }
    });

    return () => {
      cancelAnimationFrame(frame);
      if (startupHideTimer.current !== null) {
        window.clearTimeout(startupHideTimer.current);
        startupHideTimer.current = null;
      }
      unsubscribe();
    };
  }, []);

  // Handle .dividr file opened via double-click or file association
  useEffect(() => {
    const handleOpenProjectFile = async (filePath: string) => {
      try {
        // Ensure projects are initialized before importing
        await initializeProjects();

        // Import the project from the file path
        const projectId = await importProjectFromPath(filePath);

        // Open the imported project
        await openProject(projectId);

        // Navigate to the video editor
        router.navigate('/video-editor');

        toast.success('Project opened successfully!');
      } catch (error) {
        console.error('[App] Failed to open project file', error);
        toast.error('Failed to open project file');
      }
    };

    // Register listener for file open events from main process
    window.appControl?.onOpenProjectFile(handleOpenProjectFile);

    return () => {
      // Cleanup listener on unmount
      window.appControl?.offOpenProjectFile();
    };
  }, [importProjectFromPath, openProject, initializeProjects]);

  return (
    <ThemeProvider defaultTheme="soft-dark" storageKey="vite-ui-theme">
      <WindowStateProvider>
        <RuntimeStatusProvider>
          {/* Progressive startup status - non-blocking */}
          {showStartupStatus && (
            <StartupLoader
              stage={startupStage}
              progress={startupProgress}
              isVisible={showStartupStatus}
            />
          )}

          {/* Banner for missing runtime - shown after startup */}
          <RuntimeMissingBanner
            onDownloadClick={() => setShowGlobalDownloadModal(true)}
          />

          <RouterProvider router={router} />
          <Toaster
            richColors
            position="bottom-right"
            style={{ fontFamily: 'inherit' }}
          />

          {/* Global runtime download modal */}
          <RuntimeDownloadModal
            isOpen={showGlobalDownloadModal}
            onClose={() => setShowGlobalDownloadModal(false)}
            featureName="AI Features"
          />
        </RuntimeStatusProvider>
      </WindowStateProvider>
    </ThemeProvider>
  );
}

export default App;
