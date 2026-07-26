import { FileType } from '../common/enums.js';

export type CitationSourceType =
  | 'journal'
  | 'book'
  | 'report'
  | 'slide'
  | 'web'
  | 'unknown';

interface CitationFormatInput {
  file_name: string | null;
  file_type?: FileType | string | null;
  section_title?: string | null;
  page_number?: number | null;
}

export interface GbtLedgerInput extends CitationFormatInput {
  claim_id: string;
  output_char_start: number;
  file_id: string;
  page_start: number | null;
  page_end: number | null;
  heading_path: string[];
  exact_span_document_start: number | null;
  exact_span_document_end: number | null;
}

export interface GbtLedgerRender {
  references: Array<{ number: number; file_id: string; text: string }>;
  claim_links: Array<{ claim_id: string; reference_number: number }>;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim();
}

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

  if (
    normalizedType === String(FileType.PPTX) ||
    normalizedName.endsWith('.pptx')
  ) {
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
    normalizedType === String(FileType.PDF) ||
    normalizedType === String(FileType.DOCX) ||
    normalizedType === String(FileType.MD) ||
    normalizedType === String(FileType.TXT)
  ) {
    return 'book';
  }

  return 'unknown';
}

export function formatCitationReference(input: CitationFormatInput): string {
  const fileName = input.file_name?.trim() || '未命名资料';
  const title = stripExtension(fileName) || fileName;
  const sourceType = inferCitationSourceType(fileName, input.file_type);

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
  if (input.section_title) {
    extras.push(input.section_title.trim());
  }
  if (input.page_number != null) {
    extras.push(`第${input.page_number}页`);
  }

  return extras.length > 0
    ? `${title}${typeTag}. ${extras.join('，')}.`
    : `${title}${typeTag}.`;
}

export function renderGbt7714Ledger(values: GbtLedgerInput[]): GbtLedgerRender {
  const ordered = [...values].sort(
    (left, right) =>
      left.output_char_start - right.output_char_start ||
      left.claim_id.localeCompare(right.claim_id) ||
      left.file_id.localeCompare(right.file_id),
  );
  const numberByFile = new Map<string, number>();
  const references: GbtLedgerRender['references'] = [];
  const claimLinks: GbtLedgerRender['claim_links'] = [];

  for (const value of ordered) {
    let number = numberByFile.get(value.file_id);
    if (number === undefined) {
      number = references.length + 1;
      numberByFile.set(value.file_id, number);
      references.push({
        number,
        file_id: value.file_id,
        text: formatLedgerReference(value),
      });
    }
    claimLinks.push({
      claim_id: value.claim_id,
      reference_number: number,
    });
  }
  return { references, claim_links: claimLinks };
}

function formatLedgerReference(input: GbtLedgerInput): string {
  const fileName = input.file_name?.trim() || '未命名资料';
  const title = stripExtension(fileName) || fileName;
  const sourceType = inferCitationSourceType(fileName, input.file_type);
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
  const location: string[] = [];
  if (input.heading_path.length > 0) {
    location.push(input.heading_path.join(' > '));
  }
  if (input.page_start !== null) {
    const label = sourceType === 'slide' ? '张' : '页';
    location.push(
      input.page_end !== null && input.page_end !== input.page_start
        ? `第${input.page_start}-${input.page_end}${label}`
        : `第${input.page_start}${label}`,
    );
  }
  if (
    input.exact_span_document_start !== null &&
    input.exact_span_document_end !== null
  ) {
    location.push(
      `字符${input.exact_span_document_start}-${input.exact_span_document_end}`,
    );
  }
  return location.length > 0
    ? `${title}${typeTag}. ${location.join('，')}.`
    : `${title}${typeTag}.`;
}
