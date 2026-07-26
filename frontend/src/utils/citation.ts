import { FileType, type Citation } from '@/types';

export type CitationSourceType =
  | 'journal'
  | 'book'
  | 'report'
  | 'slide'
  | 'web'
  | 'unknown';

export function inferCitationSourceType(
  fileName: string | null,
  fileType?: FileType | string | null,
): CitationSourceType {
  const normalizedName = (fileName ?? '').toLowerCase();
  const normalizedType = (fileType ?? '').toLowerCase();

  if (
    normalizedName.startsWith('http://') ||
    normalizedName.startsWith('https://') ||
    normalizedType === 'url'
  ) {
    return 'web';
  }

  if (normalizedType === FileType.PPTX || normalizedName.endsWith('.pptx')) {
    return 'slide';
  }

  if (
    normalizedName.includes('学报') ||
    normalizedName.includes('期刊') ||
    normalizedName.includes('杂志') ||
    normalizedName.includes('journal')
  ) {
    return 'journal';
  }

  if (
    normalizedName.includes('白皮书') ||
    normalizedName.includes('报告') ||
    normalizedName.includes('标准')
  ) {
    return 'report';
  }

  if (
    normalizedType === FileType.PDF ||
    normalizedType === FileType.DOCX ||
    normalizedType === FileType.MD ||
    normalizedType === FileType.TXT
  ) {
    return 'book';
  }

  return 'unknown';
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim();
}

export function formatCitationReference(
  citation: Pick<
    Citation,
    | 'file_name'
    | 'file_type'
    | 'section_title'
    | 'page_number'
    | 'reference_text'
    | 'source_type'
  >,
): string {
  if (citation.reference_text) {
    return citation.reference_text;
  }

  const fileName = citation.file_name?.trim() || '未命名资料';
  const title = stripExtension(fileName) || fileName;
  const sourceType =
    citation.source_type ??
    inferCitationSourceType(fileName, citation.file_type);

  const typeTag =
    sourceType === 'journal'
      ? '[J]'
      : sourceType === 'report'
        ? '[R]'
        : sourceType === 'slide'
          ? '[Z]'
          : sourceType === 'web'
            ? '[EB/OL]'
            : '[M]';

  const extras: string[] = [];
  if (citation.section_title) {
    extras.push(citation.section_title.trim());
  }
  if (citation.page_number != null) {
    extras.push(`第${citation.page_number}页`);
  }

  return extras.length > 0
    ? `${title}${typeTag}. ${extras.join('，')}.`
    : `${title}${typeTag}.`;
}
