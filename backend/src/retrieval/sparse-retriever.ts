import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type {
  RetrievalCandidate,
  SparseSearchRequest,
  SparseRetrieverPort,
} from './types.js';

interface SparseRow {
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
  sparse_score: string | number;
  file_name: string;
  keywords: string | string[] | null;
}

@Injectable()
export class SparseRetriever implements SparseRetrieverPort {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async search(request: SparseSearchRequest): Promise<RetrievalCandidate[]> {
    if (!request.sparse_query.trim()) return [];
    const rows = await this.dataSource.query<SparseRow[]>(
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
              c.token_count,
              sf.file_name,
              c.keywords,
              MATCH(c.search_text) AGAINST(? IN BOOLEAN MODE) AS sparse_score
         FROM chunks c
         JOIN source_files sf ON sf.id = c.file_id
        WHERE MATCH(c.search_text) AGAINST(? IN BOOLEAN MODE)
          AND c.project_id = ?
          AND c.is_active = 1
          AND c.chunk_type = 'child'
        ORDER BY sparse_score DESC, c.id ASC
        LIMIT ?`,
      [
        request.sparse_query,
        request.sparse_query,
        request.project_id,
        request.limit,
      ],
    );

    return rows.map((row) => ({
      ...row,
      heading_path: normalizeHeadingPath(row.heading_path),
      page_start: nullableNumber(row.page_start),
      page_end: nullableNumber(row.page_end),
      char_start: nullableNumber(row.char_start),
      char_end: nullableNumber(row.char_end),
      position: Number(row.position),
      token_count: Number(row.token_count),
      source: 'sparse',
      source_score: Number(row.sparse_score),
      file_name: row.file_name,
      keywords: normalizeKeywords(row.keywords),
    }));
  }
}

function normalizeKeywords(value: string | string[] | null): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
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
