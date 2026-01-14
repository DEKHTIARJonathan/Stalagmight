import { useEffect } from 'react';
import { useProject } from '../../hooks/useProject';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import SystemCard from './SystemCard';

export default function GlobalView() {
  const {
    recentProjects,
    isLoading,
    handleNewProject,
    handleOpenProject,
    handleImportDmp,
  } = useProject();

  const { loadRecentProjects } = useProjectStore();

  useEffect(() => {
    loadRecentProjects();
  }, [loadRecentProjects]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Button onClick={() => handleImportDmp()}>Import DMP</Button>
          <Button onClick={() => handleNewProject()}>New Project</Button>
          <Button onClick={() => handleOpenProject()}>Open Project</Button>
        </div>
        <h1 className="text-xl font-bold">CaveChef</h1>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-text-secondary">Loading...</div>
          </div>
        ) : recentProjects.length === 0 ? (
          <EmptyState
            onImport={handleImportDmp}
            onNew={handleNewProject}
            onOpen={handleOpenProject}
          />
        ) : (
          <div>
            <h2 className="text-lg font-medium mb-4">Recent Projects</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {recentProjects.map((project) => (
                <SystemCard
                  key={project.file_path}
                  name={project.name}
                  location={project.location}
                  filePath={project.file_path}
                  modifiedAt={project.modified_at}
                  sectionCount={project.section_count}
                  totalLength={project.total_length}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Status bar */}
      <footer className="px-4 py-2 border-t border-border text-sm text-text-secondary flex justify-between">
        <span>
          Systems: {recentProjects.length}
        </span>
        <span>Status: Ready</span>
      </footer>
    </div>
  );
}

interface EmptyStateProps {
  onImport: () => void;
  onNew: () => void;
  onOpen: () => void;
}

function EmptyState({ onImport, onNew, onOpen }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold mb-2">No cave systems yet</h2>
        <p className="text-text-secondary">
          Import a DMP file from your mNemo device, or create a new project
        </p>
      </div>
      <div className="flex gap-4">
        <Button variant="primary" onClick={onImport}>
          Import DMP
        </Button>
        <Button onClick={onNew}>New Project</Button>
        <Button onClick={onOpen}>Open Existing</Button>
      </div>
    </div>
  );
}
