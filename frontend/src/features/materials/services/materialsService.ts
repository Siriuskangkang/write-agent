import { fileService } from '@/services/fileService';
import { ParseStatus } from '@/types';

export const materialsService = {
  async hasFilesBeingParsed(projectId: string): Promise<boolean> {
    const response = await fileService.listFiles(projectId, {
      page: 1,
      page_size: 100,
    });
    if (!response.success) return false;
    return response.data.items.some(
      (file) =>
        file.parse_status === ParseStatus.PENDING ||
        file.parse_status === ParseStatus.PARSING,
    );
  },
};
