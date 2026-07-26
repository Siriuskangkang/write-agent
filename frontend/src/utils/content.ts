export function normalizeGeneratedContent(content: string): string {
  if (!content) {
    return content;
  }

  let normalized = content.replace(/\r\n/g, '\n');

  normalized = normalized.replace(
    /<sup>\s*(\d+(?:\s*,\s*\d+)*)\s*<\/sup>/gi,
    (_, citation: string) => `[${citation.replace(/\s+/g, '')}]`,
  );
  normalized = normalized.replace(
    /\$\$\s*([\s\S]*?)\s*\$\$/g,
    (_, expr: string) => `\n${expr.trim()}\n`,
  );
  normalized = normalized.replace(
    /\\\[\s*([\s\S]*?)\s*\\\]/g,
    (_, expr: string) => `\n${expr.trim()}\n`,
  );
  normalized = normalized.replace(
    /\\\(\s*([\s\S]*?)\s*\\\)/g,
    (_, expr: string) => expr.trim(),
  );
  normalized = normalized.replace(/&nbsp;/gi, ' ');
  normalized = normalized.replace(/\n{3,}/g, '\n\n');

  return normalized.trim();
}
