import type { OutlineContent } from '@/types';

function extractJsonPayload(content: string): string {
  const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return content.slice(firstBrace, lastBrace + 1);
  }

  return content.trim();
}

export function parseOutlineContent(content: string): OutlineContent {
  const jsonStr = extractJsonPayload(content);
  return JSON.parse(jsonStr) as OutlineContent;
}
