function stripCodeFence(content: string): string {
  let cleaned = content.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

export function extractJsonPayload(content: string): string {
  const cleaned = stripCodeFence(content);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return cleaned;
}

export function repairJsonLikeContent(content: string): string {
  const source = extractJsonPayload(content)
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/\u00A0/g, ' ')
    .replace(/,\s*([}\]])/g, '$1');

  let repaired = '';
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (escapeNext) {
      repaired += char;
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      repaired += char;
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      if (!inString) {
        inString = true;
        repaired += char;
        continue;
      }

      let nextIndex = i + 1;
      while (nextIndex < source.length && /\s/.test(source[nextIndex])) {
        nextIndex += 1;
      }

      const nextChar = source[nextIndex];
      if (nextChar && ![',', '}', ']', ':'].includes(nextChar)) {
        repaired += '\\"';
        continue;
      }

      inString = false;
      repaired += char;
      continue;
    }

    if ((char === '\n' || char === '\r') && inString) {
      repaired += '\\n';
      continue;
    }

    repaired += char;
  }

  return repaired;
}

export function parseJsonSafely<T>(content: string): T {
  const attempts = [extractJsonPayload(content), repairJsonLikeContent(content)];
  let lastError: unknown = null;

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('JSON 解析失败');
}
