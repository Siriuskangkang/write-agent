import { Injectable } from '@nestjs/common';

@Injectable()
export class StyleTemplateTextCacheService {
  private readonly cache = new Map<string, string>();

  set(templateId: string, textContent: string): void {
    this.cache.set(templateId, textContent);
  }

  get(templateId: string): string | undefined {
    return this.cache.get(templateId);
  }

  delete(templateId: string): void {
    this.cache.delete(templateId);
  }
}
