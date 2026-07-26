import api from '@/services/api';
import type { StyleTemplate, StyleRule, StyleFeatures, UploadResponse } from '@/components/workbench/StyleTemplate/types';

export async function analyzeTextStyleTemplate(projectId: string, textContent: string): Promise<StyleTemplate> {
  return api.post('style-templates/analyze-text', {
    json: { projectId, textContent },
    timeout: 30000,
  }).json();
}

export async function uploadStyleTemplateFile(projectId: string, file: File): Promise<StyleTemplate> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('projectId', projectId);

  return api.post('style-templates/upload', { body: formData, timeout: 120000 }).json();
}

export async function getProjectStyleTemplate(projectId: string): Promise<StyleTemplate | null> {
  try {
    return await api.get(`style-templates/project/${projectId}/active`).json();
  } catch (error: any) {
    if (error.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function getStyleTemplates(projectId: string): Promise<StyleTemplate[]> {
  return api.get('style-templates', { searchParams: { projectId } }).json();
}

export async function getStyleTemplate(id: string, projectId: string): Promise<StyleTemplate> {
  return api.get(`style-templates/${id}`, { searchParams: { projectId } }).json();
}

export async function saveStyleTemplate(data: {
  id?: string;
  name: string;
  rules: StyleRule[];
}): Promise<StyleTemplate> {
  if (data.id) {
    return api.put(`style-templates/${data.id}`, { json: data }).json();
  }
  return api.post('style-templates', { json: data }).json();
}

export async function activateStyleTemplate(id: string): Promise<void> {
  await api.post(`style-templates/${id}/activate`).json();
}

export async function deleteStyleTemplate(id: string, projectId: string): Promise<void> {
  await api.delete(`style-templates/${id}`, { searchParams: { projectId } }).json();
}

export async function updateStyleTemplate(
  id: string,
  projectId: string,
  data: { features?: StyleFeatures; name?: string; panel_assignment?: import('@/components/workbench/StyleTemplate/types').PanelAssignment }
): Promise<StyleTemplate> {
  return api.patch(`style-templates/${id}`, { searchParams: { projectId }, json: data }).json();
}

export async function handleApiError(error: unknown): Promise<string> {
  if (error instanceof Error) {
    try {
      const response = await (error as Error & { response?: { json: () => Promise<{ message?: string }> } }).response?.json();
      return response?.message || error.message;
    } catch {
      return error.message;
    }
  }
  return '未知错误';
}
