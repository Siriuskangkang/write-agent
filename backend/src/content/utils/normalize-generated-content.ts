export function normalizeGeneratedContent(content: string): string {
  if (!content) {
    return content;
  }

  let normalized = content.replace(/\r\n/g, '\n');

  // Convert HTML superscript citations into the plain citation format
  // expected by the editor and markdown export.
  normalized = normalized.replace(
    /<sup>\s*(\d+(?:\s*,\s*\d+)*)\s*<\/sup>/gi,
    (_, citation: string) => `[${citation.replace(/\s+/g, '')}]`,
  );

  // Unwrap common math wrappers so formulas remain readable even when
  // the preview/export pipeline does not support LaTeX rendering.
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
