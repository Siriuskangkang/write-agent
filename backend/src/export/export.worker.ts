import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as Bull from 'bull';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ExportJob } from './entities/export-job.entity.js';
import { ExportFormat, ExportScope } from '../common/enums.js';
import { ExportService } from './export.service.js';
import { generateDocx } from './generators/docx.generator.js';
import type { DocxChapter, DocxCitation } from './generators/docx.generator.js';
import { generateMarkdown } from './generators/markdown.generator.js';
import {
  formatCitationReference,
  renderGbt7714Ledger,
} from '../citation/citation-format.js';
import { normalizeGeneratedContent } from '../content/utils/normalize-generated-content.js';

interface DirectoryNode {
  node_id: string;
  title: string;
  node_type: 'chapter' | 'section';
  parent_node_id: string | null;
  order_index: number;
}

interface ProjectRow {
  name: string | null;
}

interface DirectoryRow {
  content: DirectoryNode[] | null;
}

interface WritingResultRow {
  wr_id: string;
  content_text: string;
}

interface ContentVersionRow {
  content_text: string;
}

interface CitationRow {
  cm_claim_id: string | null;
  cm_file_id: string;
  cm_paragraph_key: string;
  cm_evidence_text: string;
  cm_page_number: number | null;
  cm_section_title: string | null;
  cm_use_type: string;
  cm_evidence_char_start: number | null;
  cm_evidence_char_end: number | null;
  gc_claim_text: string | null;
  gc_output_char_start: number | null;
  ch_page_start: number | null;
  ch_page_end: number | null;
  ch_heading_path: string[] | string | null;
  sf_file_name: string | null;
  sf_file_type: string | null;
}

export interface ExportLedgerRow extends CitationRow {
  document_order: number;
}

@Processor('export')
export class ExportWorker {
  private readonly logger = new Logger(ExportWorker.name);

  constructor(
    @InjectRepository(ExportJob)
    private readonly exportJobRepo: Repository<ExportJob>,
    private readonly exportService: ExportService,
  ) {}

  @Process('generate')
  async handleExport(
    job: Bull.Job<{ exportJobId: string; projectId: string }>,
  ) {
    const { exportJobId } = job.data;
    this.logger.log(`Processing export job: ${exportJobId}`);

    try {
      const exportJob = await this.exportJobRepo.findOne({
        where: { id: exportJobId },
      });

      if (!exportJob) {
        throw new Error(`Export job ${exportJobId} not found`);
      }

      await this.exportJobRepo.update(exportJobId, { status: 'processing' });

      const { projectTitle, chapters, citations } =
        await this.fetchProjectContent(exportJob.project_id, exportJob);

      // 确保导出目录存在
      const exportDir = await this.exportService.getExportDir();

      let content: string | Buffer;
      let filePath: string;

      if (exportJob.format === ExportFormat.DOCX) {
        content = await generateDocx({
          projectTitle,
          chapters,
          citations: exportJob.include_citations ? citations : [],
          includeCitations: exportJob.include_citations,
        });
        filePath = path.join(
          exportDir,
          `${exportJob.project_id}_${Date.now()}.docx`,
        );
        await fs.writeFile(filePath, content);
      } else {
        content = generateMarkdown({
          projectTitle,
          chapters,
          citations: exportJob.include_citations ? citations : [],
          includeCitations: exportJob.include_citations,
        });
        filePath = path.join(
          exportDir,
          `${exportJob.project_id}_${Date.now()}.md`,
        );
        await fs.writeFile(filePath, content, 'utf-8');
      }

      await this.exportJobRepo.update(exportJobId, {
        status: 'completed',
        file_path: filePath,
        completed_at: new Date(),
      });

      this.logger.log(`Export job ${exportJobId} completed: ${filePath}`);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Unknown export error';
      this.logger.error(`Export job ${exportJobId} failed: ${message}`);
      await this.exportJobRepo.update(exportJobId, {
        status: 'failed',
        error_message: message,
      });
    }
  }

  private async fetchProjectContent(
    projectId: string,
    exportJob: ExportJob,
  ): Promise<{
    projectTitle: string;
    chapters: DocxChapter[];
    citations: DocxCitation[];
  }> {
    // 查询项目标题
    const projectRow = await this.exportJobRepo.manager
      .createQueryBuilder()
      .select('p.name', 'name')
      .from('projects', 'p')
      .where('p.id = :projectId', { projectId })
      .getRawOne<ProjectRow>();

    const projectTitle = projectRow?.name || '未命名项目';

    // 查询当前版本的目录结构
    const directoryRow = await this.exportJobRepo.manager
      .createQueryBuilder()
      .select('dv.content', 'content')
      .from('directory_versions', 'dv')
      .where('dv.project_id = :projectId', { projectId })
      .andWhere('dv.is_current = true')
      .getRawOne<DirectoryRow>();

    if (!directoryRow || !directoryRow.content) {
      return { projectTitle, chapters: [], citations: [] };
    }

    let directoryNodes: DirectoryNode[] = directoryRow.content;

    if (
      exportJob.scope === ExportScope.CHAPTERS &&
      exportJob.chapter_ids &&
      exportJob.chapter_ids.length > 0
    ) {
      const allowedChapterIds = new Set(exportJob.chapter_ids);
      directoryNodes = directoryNodes.filter((node) => {
        if (node.node_type === 'chapter') {
          return allowedChapterIds.has(node.node_id);
        }
        return (
          node.parent_node_id != null &&
          allowedChapterIds.has(node.parent_node_id)
        );
      });
    }

    // 按树形层级顺序递归展开：支持任意层级深度
    const orderedNodes: typeof directoryNodes = [];
    const appendSubtree = (parentId: string | null) => {
      const children = directoryNodes
        .filter((n) => n.parent_node_id === parentId)
        .sort((a, b) => a.order_index - b.order_index);
      for (const child of children) {
        orderedNodes.push(child);
        appendSubtree(child.node_id);
      }
    };
    appendSubtree(null);

    // 预计算每个节点的深度（根节点=1）
    const depthMap = new Map<string, number>();
    const computeDepth = (nodeId: string | null, depth: number) => {
      const children = directoryNodes.filter(
        (n) => n.parent_node_id === nodeId,
      );
      for (const child of children) {
        depthMap.set(child.node_id, depth);
        computeDepth(child.node_id, depth + 1);
      }
    };
    computeDepth(null, 1);

    const allCitationRows: ExportLedgerRow[] = [];

    // 遍历目录节点，收集所有内容
    const allEntries: Array<{
      title: string;
      level: number;
      paragraphs: string[];
    }> = [];

    for (const node of orderedNodes) {
      if (node.node_type === 'chapter') {
        // 章节点：只记录标题占位
        allEntries.push({
          title: node.title,
          level: depthMap.get(node.node_id) ?? 1,
          paragraphs: [],
        });
      } else if (node.node_type === 'section') {
        // 小节节点：查询正文内容
        const sectionNodeId = node.node_id;

        // 仅按 section_node_id 查询，兼容多级树结构
        const resultRow = await this.exportJobRepo.manager
          .createQueryBuilder()
          .select(['wr.id AS wr_id', 'wr.content_text AS content_text'])
          .from('writing_results', 'wr')
          .where('wr.project_id = :projectId', { projectId })
          .andWhere('wr.section_node_id = :sectionNodeId', { sectionNodeId })
          .orderBy('wr.created_at', 'DESC')
          .limit(1)
          .getRawOne<WritingResultRow>();

        if (!resultRow || !resultRow.content_text) {
          // 没有正文内容，跳过
          continue;
        }

        // 检查是否有更新的版本（使用最大版本号）
        const versionRow = await this.exportJobRepo.manager
          .createQueryBuilder()
          .select('cv.content_text', 'content_text')
          .from('content_versions', 'cv')
          .where('cv.result_id = :resultId', { resultId: resultRow.wr_id })
          .orderBy('cv.version_number', 'DESC')
          .limit(1)
          .getRawOne<ContentVersionRow>();

        const contentText = normalizeGeneratedContent(
          versionRow?.content_text || resultRow.content_text,
        );

        // 提取纯正文：去掉 HTML 注释标记、引用行、引用块分隔线
        const paragraphs = contentText
          .split('\n')
          .map((p: string) => p.trim())
          .filter((p: string) => {
            if (p.length === 0) return false;
            // 去掉 HTML 注释（column、paragraph_key、citations 标记）
            if (p.startsWith('<!--')) return false;
            // 去掉引用行：- [chunk_id](use_type: ...) 引用说明
            if (/^-\s*\[.+\]\(use_type:/i.test(p)) return false;
            // 去掉引用分隔线
            if (/^---+$/.test(p)) return false;
            return true;
          });

        allEntries.push({
          title: node.title,
          level: depthMap.get(node.node_id) ?? 2,
          paragraphs,
        });

        // 查询引用
        const cites = await this.exportJobRepo.manager
          .createQueryBuilder()
          .select([
            'cm.claim_id',
            'cm.file_id',
            'cm.paragraph_key',
            'cm.evidence_text',
            'cm.page_number',
            'cm.section_title',
            'cm.use_type',
            'cm.evidence_char_start',
            'cm.evidence_char_end',
            'gc.claim_text',
            'gc.output_char_start',
            'ch.page_start',
            'ch.page_end',
            'ch.heading_path',
            'sf.file_name',
            'sf.file_type',
          ])
          .from('citation_maps', 'cm')
          .leftJoin('source_files', 'sf', 'sf.id = cm.file_id')
          .leftJoin('grounding_claims', 'gc', 'gc.claim_id = cm.claim_id')
          .leftJoin('chunks', 'ch', 'ch.id = cm.chunk_id')
          .where('cm.result_id = :resultId', { resultId: resultRow.wr_id })
          .getRawMany<CitationRow>();

        for (const cite of cites) {
          allCitationRows.push({
            ...cite,
            document_order:
              allEntries.length * 10_000_000 +
              Number(cite.gc_output_char_start ?? 0),
          });
        }
      }
    }

    return {
      projectTitle,
      chapters: allEntries,
      citations: buildExportCitationLedger(allCitationRows),
    };
  }
}

export function buildExportCitationLedger(
  rows: ExportLedgerRow[],
): DocxCitation[] {
  const verifiable = rows.filter(
    (
      row,
    ): row is ExportLedgerRow & {
      cm_claim_id: string;
      gc_claim_text: string;
      gc_output_char_start: number;
    } =>
      typeof row.cm_claim_id === 'string' &&
      typeof row.gc_claim_text === 'string' &&
      row.gc_output_char_start !== null,
  );
  const rendered = renderGbt7714Ledger(
    verifiable.map((row) => ({
      claim_id: row.cm_claim_id,
      output_char_start: row.document_order,
      file_id: row.cm_file_id,
      file_name: row.sf_file_name,
      file_type: row.sf_file_type,
      section_title: row.cm_section_title,
      page_number: row.cm_page_number,
      page_start: row.ch_page_start,
      page_end: row.ch_page_end,
      heading_path: parseHeadingPath(row.ch_heading_path),
      exact_span_document_start: row.cm_evidence_char_start,
      exact_span_document_end: row.cm_evidence_char_end,
    })),
  );
  const rowsByFile = new Map<string, typeof verifiable>();
  for (const row of verifiable) {
    const grouped = rowsByFile.get(row.cm_file_id) ?? [];
    grouped.push(row);
    rowsByFile.set(row.cm_file_id, grouped);
  }
  const citations: DocxCitation[] = rendered.references.map((reference) => {
    const sourceRows = [...(rowsByFile.get(reference.file_id) ?? [])].sort(
      (left, right) =>
        left.document_order - right.document_order ||
        left.cm_claim_id.localeCompare(right.cm_claim_id),
    );
    const first = sourceRows[0];
    return {
      paragraph_key: first?.cm_paragraph_key ?? '',
      file_name: first?.sf_file_name ?? '未知文件',
      evidence_text: [...new Set(sourceRows.map((row) => row.cm_evidence_text))]
        .filter(Boolean)
        .join('；'),
      page_number: first?.cm_page_number ?? null,
      use_type: first?.cm_use_type ?? 'synthesize',
      reference_text: reference.text,
      reference_number: reference.number,
      claim_texts: [
        ...new Set(sourceRows.map((row) => row.gc_claim_text).filter(Boolean)),
      ],
    };
  });
  const verifiableKeys = new Set(verifiable);
  const legacy = rows
    .filter((row) => !verifiableKeys.has(row as never))
    .map((row) => ({
      paragraph_key: row.cm_paragraph_key,
      file_name: row.sf_file_name ?? '未知文件',
      evidence_text: row.cm_evidence_text,
      page_number: row.cm_page_number,
      use_type: row.cm_use_type,
      reference_text: formatCitationReference({
        file_name: row.sf_file_name ?? '未知文件',
        file_type: row.sf_file_type ?? null,
        section_title: row.cm_section_title,
        page_number: row.cm_page_number,
      }),
      reference_number: citations.length + 1,
      claim_texts: [],
    }));
  return [...citations, ...legacy];
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
