import api from './api';
import type { ApiResponse, DirectoryNode, OutlineContent, OutlineVersion, WritingResult } from '@/types';

export const contentService = {
  async getOutline(projectId: string, outlineId: string): Promise<ApiResponse<OutlineVersion>> {
    return api.get(`projects/${projectId}/outline/${outlineId}`).json();
  },

  async getLatestOutlineByChapter(
    projectId: string,
    chapterNodeId: string,
    sectionNodeId?: string | null,
  ): Promise<ApiResponse<OutlineVersion | null>> {
    return api.get(`projects/${projectId}/outline/chapter/${chapterNodeId}/latest`, {
      searchParams: sectionNodeId ? { section_node_id: sectionNodeId } : undefined,
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    }).json();
  },

  async getLatestResultBySection(projectId: string, sectionNodeId: string): Promise<ApiResponse<WritingResult | null>> {
    return api.get(`projects/${projectId}/content/section/${sectionNodeId}/latest`, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    }).json();
  },

  async saveOutline(
    projectId: string,
    data: {
      chapter_node_id: string;
      section_node_id?: string;
      chapter_index: number;
      chapter_title: string;
      base_version_number: number;
      content: OutlineContent;
    },
  ): Promise<ApiResponse<OutlineVersion>> {
    return api.post(`projects/${projectId}/outline/save`, { json: data }).json();
  },

  async getResult(projectId: string, resultId: string): Promise<ApiResponse<WritingResult>> {
    return api.get(`projects/${projectId}/content/${resultId}`).json();
  },

  async stopGeneration(projectId: string, resultId: string): Promise<ApiResponse<WritingResult>> {
    return api.post(`projects/${projectId}/content/${resultId}/stop`).json();
  },

  async updateWritingResult(projectId: string, resultId: string, content: string): Promise<ApiResponse<WritingResult>> {
    return api.patch(`projects/${projectId}/content/${resultId}`, { json: { content } }).json();
  },

  async updateOutline(projectId: string, outlineId: string, content: OutlineContent): Promise<ApiResponse<OutlineVersion>> {
    return api.patch(`projects/${projectId}/outline/${outlineId}`, { json: { content } }).json();
  },

  async updateDirectoryNode(projectId: string, nodeId: string, title: string): Promise<ApiResponse<DirectoryNode>> {
    return api.patch(`projects/${projectId}/directory/node/${nodeId}`, { json: { title } }).json();
  },

  async deleteDirectoryNode(projectId: string, nodeId: string): Promise<ApiResponse<null>> {
    return api.delete(`projects/${projectId}/directory/node/${nodeId}`).json();
  },
};
