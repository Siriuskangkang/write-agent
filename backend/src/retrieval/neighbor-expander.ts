import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { FusedCandidate } from './types.js';

interface NeighborRow {
  chunk_id: string;
  project_id: string;
  file_id: string;
  document_id: string;
  ingestion_key: string | null;
  content: string;
  section_title: string | null;
  heading_path: string | string[] | null;
  page_start: number | null;
  page_end: number | null;
  char_start: number | null;
  char_end: number | null;
  position: number;
  token_count: number;
}

const MAX_SEEDS = 8;

@Injectable()
export class NeighborExpander {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async expand(
    projectId: string,
    candidates: FusedCandidate[],
  ): Promise<FusedCandidate[]> {
    if (candidates.length === 0) return candidates;

    const seeds = [...candidates]
      .sort(
        (left, right) =>
          left.rerank_rank - right.rerank_rank ||
          left.chunk_id.localeCompare(right.chunk_id),
      )
      .slice(0, MAX_SEEDS);
    const predicates = seeds.map(
      () => '(c.document_id = ? AND c.position BETWEEN ? AND ?)',
    );
    const parameters: Array<string | number> = [projectId];
    for (const seed of seeds) {
      parameters.push(
        seed.document_id,
        Math.max(0, seed.position - 1),
        seed.position + 1,
      );
    }

    const rows = await this.dataSource.query<NeighborRow[]>(
      `SELECT c.id AS chunk_id,
              c.project_id,
              c.file_id,
              c.document_id,
              c.ingestion_key,
              c.content,
              c.section_title,
              c.heading_path,
              c.page_start,
              c.page_end,
              c.char_start,
              c.char_end,
              c.position,
              c.token_count
         FROM chunks c
        WHERE c.project_id = ?
          AND c.is_active = 1
          AND c.chunk_type = 'child'
          AND (${predicates.join(' OR ')})
        ORDER BY c.document_id ASC, c.position ASC, c.id ASC`,
      parameters,
    );

    const knownIds = new Set(candidates.map((candidate) => candidate.chunk_id));
    const seedByDocument = groupSeedsByDocument(seeds);
    const neighbors = rows
      .filter((row) => !knownIds.has(row.chunk_id))
      .map((row) => {
        const seed = closestSeed(
          seedByDocument.get(row.document_id) ?? [],
          row,
        );
        return seed ? toNeighbor(row, seed) : null;
      })
      .filter((candidate): candidate is FusedCandidate => candidate !== null)
      .sort(
        (left, right) =>
          right.rerank_score - left.rerank_score ||
          left.document_id.localeCompare(right.document_id) ||
          left.position - right.position ||
          left.chunk_id.localeCompare(right.chunk_id),
      )
      .map((candidate, index) => ({
        ...candidate,
        fusion_rank: candidates.length + index + 1,
        rerank_rank: candidates.length + index + 1,
      }));

    return [...candidates, ...neighbors];
  }
}

function groupSeedsByDocument(
  seeds: FusedCandidate[],
): Map<string, FusedCandidate[]> {
  const grouped = new Map<string, FusedCandidate[]>();
  for (const seed of seeds) {
    const values = grouped.get(seed.document_id) ?? [];
    values.push(seed);
    grouped.set(seed.document_id, values);
  }
  return grouped;
}

function closestSeed(
  seeds: FusedCandidate[],
  row: NeighborRow,
): FusedCandidate | null {
  return (
    [...seeds].sort(
      (left, right) =>
        Math.abs(left.position - Number(row.position)) -
          Math.abs(right.position - Number(row.position)) ||
        left.rerank_rank - right.rerank_rank ||
        left.chunk_id.localeCompare(right.chunk_id),
    )[0] ?? null
  );
}

function toNeighbor(row: NeighborRow, seed: FusedCandidate): FusedCandidate {
  const inheritedScore = seed.rerank_score * 0.85;
  return {
    ...row,
    heading_path: normalizeHeadingPath(row.heading_path),
    page_start: nullableNumber(row.page_start),
    page_end: nullableNumber(row.page_end),
    char_start: nullableNumber(row.char_start),
    char_end: nullableNumber(row.char_end),
    position: Number(row.position),
    token_count: Number(row.token_count),
    source: 'neighbor',
    source_score: inheritedScore,
    sparse_rank: null,
    sparse_score: null,
    dense_rank: null,
    dense_score: null,
    fusion_score: seed.fusion_score * 0.85,
    fusion_rank: 0,
    rerank_score: inheritedScore,
    rerank_rank: 0,
  };
}

function normalizeHeadingPath(value: string | string[] | null): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function nullableNumber(value: number | null): number | null {
  return value === null || value === undefined ? null : Number(value);
}
