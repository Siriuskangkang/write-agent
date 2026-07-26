import api from './api';
import type { ApiResponse, PagedData, SourceFile } from '@/types';

export const fileService = {
  uploadFiles: (projectId: string, files: File[]) => {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    return fetch(`/api/projects/${projectId}/files`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    }).then(r => r.json()) as Promise<ApiResponse<SourceFile[]>>;
  },

  listFiles: (projectId: string, params?: { page?: number; page_size?: number; parse_status?: string }) =>
    api.get(`projects/${projectId}/files`, { searchParams: params as Record<string, string | number | boolean> })
      .json<ApiResponse<PagedData<SourceFile>>>(),

  getFile: (projectId: string, fileId: string) =>
    api.get(`projects/${projectId}/files/${fileId}`).json<ApiResponse<SourceFile>>(),

  deleteFile: (projectId: string, fileId: string) =>
    api.delete(`projects/${projectId}/files/${fileId}`).json<ApiResponse<null>>(),

  reparseFile: (projectId: string, fileId: string) =>
    api.post(`projects/${projectId}/files/${fileId}/reparse`).json<ApiResponse<null>>(),
};
