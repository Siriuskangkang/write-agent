import { citationService } from '@/services/citationService';
import type { Citation } from '@/types';

export const citationWorkspaceService = {
  async loadForResult(projectId: string, resultId: string): Promise<Citation[]> {
    const response = await citationService
      .getCitations(projectId, resultId)
      .catch(() => null);
    return response?.success ? response.data : [];
  },
};
