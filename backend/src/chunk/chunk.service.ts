import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Chunk } from './entities/chunk.entity.js';
import { chunkDocument, type ChunkInput } from './chunker.js';
import { EmbeddingService } from '../embedding/embedding.service.js';
import {
  extractTopSearchTerms,
  tokenizeForSearch,
} from './search-tokenizer.js';

@Injectable()
export class ChunkService {
  private readonly logger = new Logger(ChunkService.name);

  constructor(
    @InjectRepository(Chunk)
    private readonly chunkRepo: Repository<Chunk>,
    private readonly embeddingService: EmbeddingService,
  ) {}

  async createChunksForDocument(
    projectId: string,
    fileId: string,
    documentId: string,
    input: ChunkInput,
    manager?: EntityManager,
  ): Promise<Chunk[]> {
    const chunkOutputs = chunkDocument(input);
    // TODO: generateEmbeddings 暂时注释，待向量检索功能实现时再启用
    // const embeddings = await this.embeddingService.generateEmbeddings(
    //   chunkOutputs.map((chunk) => chunk.content),
    // );

    const chunkRepo = manager?.getRepository(Chunk) ?? this.chunkRepo;
    const parentIds = new Map(
      chunkOutputs
        .filter((chunk) => chunk.chunk_type === 'parent' && chunk.stable_key)
        .map((chunk) => [
          chunk.stable_key as string,
          stableUuid(`${documentId}:${chunk.stable_key as string}`),
        ]),
    );
    const entities = chunkOutputs.map((c) => {
      const keywords = extractTopSearchTerms(c.content);
      // search_terms 用 tokenizeForSearch 产生 bigram，与检索时的 query tokenizer 保持一致
      const searchTerms = this.normalizeSearchTerms(
        tokenizeForSearch(c.content),
      );

      return chunkRepo.create({
        ...(c.stable_key
          ? { id: stableUuid(`${documentId}:${c.stable_key}`) }
          : {}),
        project_id: projectId,
        file_id: fileId,
        document_id: documentId,
        chunk_index: c.chunk_index,
        content: c.content,
        search_text: buildSearchText(
          c.content,
          c.section_title,
          c.heading_path,
        ),
        section_title: c.section_title,
        page_number: c.page_number,
        keywords,
        search_terms: searchTerms,
        stable_key: c.stable_key ?? null,
        ingestion_key: input.ingestion_key ?? null,
        chunk_type: c.chunk_type ?? 'child',
        parent_id: c.parent_key ? (parentIds.get(c.parent_key) ?? null) : null,
        position: c.position ?? c.chunk_index,
        token_count: c.token_count ?? c.content.length,
        tokenizer_version: c.tokenizer_version ?? 'legacy-char-v1',
        overlap_previous_tokens: c.overlap_previous_tokens ?? 0,
        heading_path: c.heading_path ?? null,
        page_start: c.page_start ?? c.page_number,
        page_end: c.page_end ?? c.page_number,
        block_ids: c.block_ids ?? null,
        char_start: c.char_start ?? null,
        char_end: c.char_end ?? null,
        is_active: true,
      });
    });

    if (entities.length === 0) return [];

    const parentEntities = entities.filter(
      (entity) => entity.chunk_type === 'parent',
    );
    const childEntities = entities.filter(
      (entity) => entity.chunk_type !== 'parent',
    );
    const saved = [
      ...(parentEntities.length > 0
        ? await chunkRepo.save(parentEntities)
        : []),
      ...(childEntities.length > 0 ? await chunkRepo.save(childEntities) : []),
    ];
    this.logger.log(
      `Created ${saved.length} chunks for document ${documentId}`,
    );
    return saved;
  }

  async deleteByFileId(fileId: string): Promise<void> {
    await this.chunkRepo.delete({ file_id: fileId });
  }

  async getChunksByProjectId(
    projectId: string,
    options?: {
      keyword?: string;
      file_id?: string;
      page?: number;
      page_size?: number;
    },
  ): Promise<{ items: Chunk[]; total: number }> {
    const page = options?.page ?? 1;
    const pageSize = options?.page_size ?? 20;

    const qb = this.chunkRepo
      .createQueryBuilder('c')
      .where('c.project_id = :projectId', { projectId })
      .andWhere('c.is_active = 1')
      .andWhere("c.chunk_type = 'child'");

    if (options?.file_id) {
      qb.andWhere('c.file_id = :fileId', { fileId: options.file_id });
    }

    if (options?.keyword) {
      qb.andWhere('JSON_CONTAINS(c.keywords, JSON_QUOTE(:keyword))', {
        keyword: options.keyword,
      });
    }

    qb.orderBy('c.chunk_index', 'ASC');

    const total = await qb.getCount();
    const items = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();

    return { items, total };
  }

  async getChunksByFileId(fileId: string): Promise<Chunk[]> {
    return this.chunkRepo.find({
      where: { file_id: fileId, is_active: true, chunk_type: 'child' },
      order: { chunk_index: 'ASC' },
    });
  }

  async getChunkById(chunkId: string): Promise<Chunk | null> {
    return this.chunkRepo.findOne({ where: { id: chunkId } });
  }

  async getChunkByProjectId(
    projectId: string,
    chunkId: string,
  ): Promise<Chunk | null> {
    return this.chunkRepo.findOne({
      where: { id: chunkId, project_id: projectId },
    });
  }

  private normalizeSearchTerms(keywords: string[]): string[] {
    return keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
  }
}

function buildSearchText(
  content: string,
  sectionTitle: string | null,
  headingPath: string[] | undefined,
): string {
  return [...(headingPath ?? []), sectionTitle ?? '', content]
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n');
}

function stableUuid(identity: string): string {
  const hex = createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  const variant = parseInt(hex[16] ?? '0', 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}
