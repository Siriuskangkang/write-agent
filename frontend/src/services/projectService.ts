import api from './api';
import type {
  ApiResponse,
  PagedData,
  Project,
  ProjectState,
  DirectoryVersion,
  ProjectStatus,
} from '@/types';

export interface ListProjectsParams {
  page?: number;
  page_size?: number;
}

export interface CreateProjectData {
  name: string;
  type?: string;
  target_audience?: string;
  target_chapters?: number;
  style?: string;
  description?: string;
}

export interface UpdateProjectData {
  name?: string;
  type?: string;
  target_audience?: string;
  target_chapters?: number;
  style?: string;
  description?: string;
  status?: ProjectStatus;
}

export interface UpdateProjectStateData {
  current_directory_version_id?: string | null;
  completed_chapters?: string[];
  in_progress_chapter?: string | null;
  in_progress_section?: string | null;
  pending_items?: Array<Record<string, unknown>>;
  material_gaps?: Array<Record<string, unknown>>;
  user_notes?: string | null;
}

export const projectService = {
  async listProjects(params?: ListProjectsParams): Promise<ApiResponse<PagedData<Project>>> {
    return api.get('projects', { searchParams: params as Record<string, string | number> }).json();
  },

  async createProject(data: CreateProjectData): Promise<ApiResponse<Project>> {
    return api.post('projects', { json: data }).json();
  },

  async getProject(id: string): Promise<ApiResponse<Project>> {
    return api.get(`projects/${id}`).json();
  },

  async updateProject(id: string, data: UpdateProjectData): Promise<ApiResponse<Project>> {
    return api.put(`projects/${id}`, { json: data }).json();
  },

  async deleteProject(id: string): Promise<ApiResponse<null>> {
    return api.delete(`projects/${id}`).json();
  },

  async getProjectState(id: string): Promise<ApiResponse<ProjectState>> {
    return api.get(`projects/${id}/state`).json();
  },

  async updateProjectState(
    id: string,
    data: UpdateProjectStateData,
  ): Promise<ApiResponse<ProjectState>> {
    return api.put(`projects/${id}/state`, { json: data }).json();
  },

  async getDirectory(projectId: string): Promise<ApiResponse<DirectoryVersion | null>> {
    return api.get(`projects/${projectId}/directory`).json();
  },

  async getDirectoryVersion(projectId: string, versionId: string): Promise<ApiResponse<DirectoryVersion>> {
    return api.get(`projects/${projectId}/directory/${versionId}`).json();
  },

  async saveDirectory(projectId: string, data: { base_version_number: number; nodes: any[] }): Promise<ApiResponse<DirectoryVersion>> {
    return api.post(`projects/${projectId}/directory/save`, { json: data }).json();
  },
};
