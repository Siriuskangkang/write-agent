import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { Project, ProjectState } from '@/types';

interface ProjectStore {
  projects: Project[];
  currentProject: Project | null;
  projectState: ProjectState | null;
  setProjects: (projects: Project[]) => void;
  setCurrentProject: (project: Project | null) => void;
  setProjectState: (state: ProjectState | null) => void;
}

export const useProjectStore = create<ProjectStore>()(
  devtools(
    (set) => ({
      projects: [],
      currentProject: null,
      projectState: null,
      setProjects: (projects) => set({ projects }),
      setCurrentProject: (project) => set({ currentProject: project }),
      setProjectState: (state) => set({ projectState: state }),
    }),
    { name: 'ProjectStore', enabled: process.env.NODE_ENV === 'development' }
  )
);
