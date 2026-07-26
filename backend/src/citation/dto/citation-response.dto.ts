import type { ClaimSupportStatus } from '../grounding-verifier.js';

export interface PublicCitationInput {
  id: string;
  claim_id: string | null;
  claim_text?: string | null;
  output_char_start?: number | null;
  output_char_end?: number | null;
  evidence_id: string | null;
  chunk_id: string;
  file_id: string;
  file_name?: string | null;
  file_type?: string | null;
  evidence_text: string;
  support_status: ClaimSupportStatus;
  support_score: number;
  verification_method: string;
  evidence_char_start: number | null;
  evidence_char_end: number | null;
  chunk_char_start: number | null;
  chunk_char_end: number | null;
  candidate_rank: number | null;
  sparse_rank: number | null;
  dense_rank: number | null;
  fusion_rank: number | null;
  rerank_rank: number | null;
  sparse_score: number | null;
  dense_score: number | null;
  fusion_score: number | null;
  rerank_score: number | null;
  page_start?: number | null;
  page_end?: number | null;
  heading_path?: string[] | string | null;
  reference_text: string;
  created_at: Date;
  [key: string]: unknown;
}

export interface PublicCitationDto {
  id: string;
  claim_id: string | null;
  claim_text: string | null;
  output_char_start: number | null;
  output_char_end: number | null;
  evidence_id: string | null;
  chunk_id: string;
  file_id: string;
  file_name: string | null;
  file_type: string | null;
  evidence_text: string;
  support_status: ClaimSupportStatus;
  support_score: number;
  verification_method: string;
  evidence_char_start: number | null;
  evidence_char_end: number | null;
  chunk_char_start: number | null;
  chunk_char_end: number | null;
  candidate_rank: number | null;
  scores: {
    sparse: number | null;
    dense: number | null;
    fusion: number | null;
    rerank: number | null;
  };
  ranks: {
    sparse: number | null;
    dense: number | null;
    fusion: number | null;
    rerank: number | null;
  };
  page_start: number | null;
  page_end: number | null;
  heading_path: string[];
  reference_text: string;
  created_at: Date;
}

export function toPublicCitation(
  value: PublicCitationInput,
): PublicCitationDto {
  return {
    id: value.id,
    claim_id: value.claim_id,
    claim_text: value.claim_text ?? null,
    output_char_start: value.output_char_start ?? null,
    output_char_end: value.output_char_end ?? null,
    evidence_id: value.evidence_id,
    chunk_id: value.chunk_id,
    file_id: value.file_id,
    file_name: value.file_name ?? null,
    file_type: value.file_type ?? null,
    evidence_text: value.evidence_text,
    support_status: value.support_status,
    support_score: Number(value.support_score),
    verification_method: value.verification_method,
    evidence_char_start: nullableNumber(value.evidence_char_start),
    evidence_char_end: nullableNumber(value.evidence_char_end),
    chunk_char_start: nullableNumber(value.chunk_char_start),
    chunk_char_end: nullableNumber(value.chunk_char_end),
    candidate_rank: nullableNumber(value.candidate_rank),
    scores: {
      sparse: nullableNumber(value.sparse_score),
      dense: nullableNumber(value.dense_score),
      fusion: nullableNumber(value.fusion_score),
      rerank: nullableNumber(value.rerank_score),
    },
    ranks: {
      sparse: nullableNumber(value.sparse_rank),
      dense: nullableNumber(value.dense_rank),
      fusion: nullableNumber(value.fusion_rank),
      rerank: nullableNumber(value.rerank_rank),
    },
    page_start: nullableNumber(value.page_start),
    page_end: nullableNumber(value.page_end),
    heading_path: parseHeadingPath(value.heading_path),
    reference_text: value.reference_text,
    created_at: value.created_at,
  };
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseHeadingPath(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value !== 'string') return [];
  try {
    return parseHeadingPath(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}
