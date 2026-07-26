import api from './api';
import type { ApiResponse, Citation } from '@/types';

export const citationService = {
  async getCitations(projectId: string, resultId: string): Promise<ApiResponse<Citation[]>> {
    return api.get(`projects/${projectId}/content/${resultId}/citations`).json();
  },
};
