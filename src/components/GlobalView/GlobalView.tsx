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
    <div data-testid="global-view" className="h-full flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Button onClick={() => handleImportDmp()}>Import DMP</Button>
          <Button data-testid="new-project-button" onClick={() => handleNewProject()}>New Project</Button>
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
    <div className="flex flex-col items-center justify-center h-full gap-8">
      <div className="text-center">
        <div className="text-6xl mb-4">🗺️</div>
        <h2 className="text-2xl font-bold mb-2">No cave systems yet</h2>
        <p className="text-text-secondary max-w-md">
          Start by importing survey data from your mNemo device, creating a new project,
          or opening an existing CaveChef project file.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-2xl">
        <EmptyStateCard
          icon="📥"
          title="Import DMP"
          description="Import survey data from mNemo's .dmp file format"
          onClick={onImport}
          primary
        />
        <EmptyStateCard
          icon="📝"
          title="New Project"
          description="Create a blank project and enter data manually"
          onClick={onNew}
        />
        <EmptyStateCard
          icon="📂"
          title="Open Existing"
          description="Open a previously saved .cvchef project file"
          onClick={onOpen}
        />
      </div>
    </div>
  );
}

interface EmptyStateCardProps {
  icon: string;
  title: string;
  description: string;
  onClick: () => void;
  primary?: boolean;
}

function EmptyStateCard({ icon, title, description, onClick, primary }: EmptyStateCardProps) {
  return (
    <button
      onClick={onClick}
      className={`
        p-6 rounded-lg border text-left transition-all
        hover:scale-105 hover:shadow-lg
        ${primary
          ? 'bg-accent/10 border-accent hover:bg-accent/20'
          : 'bg-panel border-border hover:bg-background/50'
        }
      `}
    >
      <div className="text-4xl mb-3">{icon}</div>
      <h3 className="font-semibold mb-1">{title}</h3>
      <p className="text-sm text-text-secondary">{description}</p>
    </button>
  );
}
