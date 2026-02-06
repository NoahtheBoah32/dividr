import StartupLoader from '@/frontend/components/custom/StartupLoader';
import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useProjectStore } from '../../projects/store/projectStore';

interface ProjectGuardProps {
  children: React.ReactNode;
}

/**
 * ProjectGuard Component
 * Ensures a project is loaded before allowing access to the video editor
 * Redirects to projects page if no project is available
 */
export const ProjectGuard: React.FC<ProjectGuardProps> = ({ children }) => {
  const { currentProject, initializeProjects, isInitialized } =
    useProjectStore();

  // Initialize projects if not already done
  useEffect(() => {
    if (!isInitialized) {
      initializeProjects();
    }
  }, [isInitialized, initializeProjects]);

  // Show loading while initializing
  if (!isInitialized) {
    return <StartupLoader stage="projects-loading" />;
  }

  // Redirect to projects page if no project is loaded
  if (!currentProject) {
    return <Navigate to="/" replace />;
  }

  // Render children if project is loaded
  return <>{children}</>;
};
