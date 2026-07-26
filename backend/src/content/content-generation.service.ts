import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  AgentService,
  type ChainInput,
  type ChainType,
} from '../agent/agent.service.js';
import { ProjectService } from '../project/project.service.js';
import { CitationService } from '../citation/citation.service.js';
import { StyleTemplateService } from '../style-template/style-template.service.js';
import { ContentSharedService } from './content-shared.service.js';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { WritingResult } from './entities/writing-result.entity.js';
import { ContentVersion } from './entities/content-version.entity.js';
import { OutlineVersion } from './entities/outline-version.entity.js';
import { GenerateContentDto } from './dto/generate-content.dto.js';
import { RewriteContentDto } from './dto/rewrite-content.dto.js';
import { ExpandContentDto } from './dto/expand-content.dto.js';
import { CompressContentDto } from './dto/compress-content.dto.js';
import {
  CitationUseType,
  TaskType,
  WritingResultStatus,
} from '../common/enums.js';
import { normalizeGeneratedContent } from './utils/normalize-generated-content.js';
import type { ModelTraceMetadata } from '../llm/model-types.js';
import type { AtomicGroundingGenerationInput } from '../citation/atomic-grounding/atomic-grounding-coordinator.service.js';
import type { SealedGroundedCandidateV1 } from '../citation/atomic-grounding/contracts.js';

interface CitationEvent {
  paragraph_key: string;
  [key: string]: unknown;
}

@Injectable()
export class ContentGenerationService {
  private readonly logger = new Logger(ContentGenerationService.name);

  constructor(
    @InjectRepository(WritingResult)
    private readonly writingResultRepo: Repository<WritingResult>,
    @InjectRepository(ContentVersion)
    private readonly contentVersionRepo: Repository<ContentVersion>,
    @InjectRepository(OutlineVersion)
    private readonly outlineVersionRepo: Repository<OutlineVersion>,
    @InjectRepository(Chunk)
    private readonly chunkRepo: Repository<Chunk>,
    private readonly agentService: AgentService,
    private readonly projectService: ProjectService,
    private readonly citationService: CitationService,
    private readonly styleTemplateService: StyleTemplateService,
    private readonly contentSharedService: ContentSharedService,
  ) {}

  private buildOutlineScope(
    projectId: string,
    chapterNodeId: string,
    sectionNodeId?: string | null,
  ) {
    return {
      project_id: projectId,
      chapter_node_id: chapterNodeId,
      section_node_id: sectionNodeId ?? IsNull(),
    };
  }

  private async getCurrentOutline(
    projectId: string,
    chapterNodeId: string,
    sectionNodeId?: string | null,
  ): Promise<OutlineVersion | null> {
    return this.outlineVersionRepo.findOne({
      where: {
        ...this.buildOutlineScope(projectId, chapterNodeId, sectionNodeId),
        is_current: true,
      },
    });
  }

  private async storeContentVersion(
    resultId: string,
    content: string,
  ): Promise<void> {
    await this.contentVersionRepo.manager.transaction(async (manager) => {
      const lockedRows: unknown = await manager.query(
        `SELECT id FROM writing_results WHERE id = ? FOR UPDATE`,
        [resultId],
      );
      if (!Array.isArray(lockedRows) || lockedRows.length === 0) {
        throw new NotFoundException('写作结果不存在');
      }
      const versionRepo = manager.getRepository(ContentVersion);
      await versionRepo.update(
        { result_id: resultId, is_current: true },
        { is_current: false },
      );
      const rows: unknown = await manager.query(
        `SELECT COALESCE(MAX(version_number), 0) AS maxVersion
           FROM content_versions
          WHERE result_id = ?`,
        [resultId],
      );
      const versionNumber =
        Array.isArray(rows) && rows.length > 0
          ? Number((rows[0] as { maxVersion?: unknown }).maxVersion ?? 0) + 1
          : 1;
      await versionRepo.save(
        versionRepo.create({
          result_id: resultId,
          version_number: versionNumber,
          content_text: content,
          is_current: true,
        }),
      );
    });
  }

  private async persistStructuredCitations(
    userId: string,
    projectId: string,
    resultId: string,
    content: string,
  ): Promise<CitationEvent[]> {
    const parsed = this.contentSharedService.parseStructuredCitations(content);
    if (parsed.length === 0) return [];

    const chunkIds = [...new Set(parsed.map((item) => item.chunk_id))];
    const chunks = await this.chunkRepo.find({
      where: { project_id: projectId, id: In(chunkIds) },
    });
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));

    const inputs = parsed.flatMap((item) => {
      const chunk = chunkMap.get(item.chunk_id);
      if (!chunk) {
        this.logger.warn(
          `引用解析失败，未找到 chunk: ${item.chunk_id}，result=${resultId}`,
        );
        return [];
      }
      return [
        {
          paragraph_key: item.paragraph_key,
          chunk_id: item.chunk_id,
          file_id: chunk.file_id,
          use_type: item.use_type,
          evidence_text:
            chunk.content.replace(/\s+/g, ' ').trim().slice(0, 300) ||
            item.description,
          page_number: chunk.page_number,
          section_title: chunk.section_title,
          confidence_score:
            item.use_type === CitationUseType.UNSUPPORTED ? 0.2 : 0.85,
        },
      ];
    });

    if (inputs.length === 0) return [];

    await this.citationService.createCitations(projectId, resultId, inputs);
    const citations: unknown =
      await this.citationService.getCitationsByResultId(
        userId,
        projectId,
        resultId,
      );
    return Array.isArray(citations)
      ? citations.filter((citation: unknown): citation is CitationEvent => {
          if (typeof citation !== 'object' || citation === null) {
            return false;
          }
          const item = citation as Record<string, unknown>;
          return typeof item.paragraph_key === 'string';
        })
      : [];
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }

  async *generateWorkflowText(
    workflowType: 'content' | 'rewrite' | 'expand' | 'compress',
    userId: string,
    projectId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    trace?: ModelTraceMetadata,
  ): AsyncGenerator<string> {
    const prepared = await this.prepareWorkflowGeneration(
      workflowType,
      userId,
      projectId,
      input,
      trace,
    );
    yield* this.agentService.generateStream(
      prepared.chainType,
      prepared.chainInput,
      { signal, ...(trace ? { trace } : {}) },
    );
  }

  async prepareAtomicGroundingInput(
    workflowType: 'content' | 'rewrite' | 'expand' | 'compress',
    userId: string,
    projectId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    trace: ModelTraceMetadata,
  ): Promise<AtomicGroundingGenerationInput> {
    const prepared = await this.prepareWorkflowGeneration(
      workflowType,
      userId,
      projectId,
      input,
      trace,
    );
    const revisionAttempt = input.revision_attempt ?? 0;
    if (revisionAttempt !== 0 && revisionAttempt !== 1) {
      throw new BadRequestException('定向修订次数无效');
    }
    const revision =
      typeof input.revision === 'object' &&
      input.revision !== null &&
      !Array.isArray(input.revision)
        ? (input.revision as AtomicGroundingGenerationInput['revision'])
        : undefined;
    return {
      workflow_job_id: trace.workflow_job_id,
      project_id: projectId,
      workflow_type: workflowType,
      generation_attempt: trace.attempt,
      revision_attempt: revisionAttempt,
      authoring_context: prepared.authoringContext,
      signal,
      ...(revision ? { revision } : {}),
    };
  }

  async prepareAtomicGroundingRevisionInput(
    workflowType: 'content' | 'rewrite' | 'expand' | 'compress',
    userId: string,
    projectId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    trace: ModelTraceMetadata,
    persistSealedCandidate?: (
      candidate: SealedGroundedCandidateV1,
    ) => Promise<void>,
  ): Promise<AtomicGroundingGenerationInput> {
    if (input.revision_attempt !== 1) {
      throw new BadRequestException('定向修订次数无效');
    }
    const revision =
      typeof input.revision === 'object' &&
      input.revision !== null &&
      !Array.isArray(input.revision)
        ? (input.revision as AtomicGroundingGenerationInput['revision'])
        : undefined;
    if (!revision) throw new BadRequestException('定向修订约束缺失');
    const grounding = await this.contentSharedService.loadGroundingMaterials(
      projectId,
      trace.workflow_job_id,
    );
    const prepared = await this.prepareWorkflowGeneration(
      workflowType,
      userId,
      projectId,
      input,
      trace,
      grounding,
    );
    return {
      workflow_job_id: trace.workflow_job_id,
      project_id: projectId,
      workflow_type: workflowType,
      generation_attempt: trace.attempt,
      revision_attempt: 1,
      authoring_context: prepared.authoringContext,
      signal,
      revision,
      ...(persistSealedCandidate
        ? { persist_sealed_candidate: persistSealedCandidate }
        : {}),
    };
  }

  private async prepareWorkflowGeneration(
    workflowType: 'content' | 'rewrite' | 'expand' | 'compress',
    userId: string,
    projectId: string,
    input: Record<string, unknown>,
    trace?: ModelTraceMetadata,
    assignedGrounding?: { materials: string; evidenceIds: string[] },
  ): Promise<{
    chainType: Extract<
      ChainType,
      'content' | 'rewrite' | 'expand' | 'compress'
    >;
    chainInput: ChainInput;
    authoringContext: Record<string, unknown>;
  }> {
    const project = await this.projectService.findOne(userId, projectId);
    if (workflowType === 'content') {
      const template =
        await this.styleTemplateService.getProjectActiveTemplate(projectId);
      if (!template || !template.features) {
        throw new ConflictException('请先上传并分析体例文件');
      }
      const chapterNodeId = requireWorkflowString(input, 'chapter_node_id');
      const sectionNodeId = requireWorkflowString(input, 'section_node_id');
      const outline = await this.getCurrentOutline(projectId, chapterNodeId);
      const query =
        [input.chapter_title, input.section_title]
          .filter((value): value is string => typeof value === 'string')
          .join(' ') || project.name;
      const strictCitation = input.strict_citation !== false;
      const grounding = assignedGrounding
        ? assignedGrounding
        : trace?.workflow_job_id
          ? await this.contentSharedService.retrieveGroundingMaterials(
              projectId,
              query,
              trace.workflow_job_id,
              strictCitation,
            )
          : {
              materials: await this.contentSharedService.retrieveMaterials(
                projectId,
                query,
              ),
              evidenceIds: [] as string[],
            };
      const stylePrompt =
        await this.contentSharedService.getStructureTreePrompt(
          projectId,
          'content',
        );
      const chainInput = {
        projectName: project.name,
        style: typeof input.style === 'string' ? input.style : project.style,
        chapterTitle:
          typeof input.chapter_title === 'string'
            ? input.chapter_title
            : chapterNodeId,
        sectionTitle:
          typeof input.section_title === 'string'
            ? input.section_title
            : sectionNodeId,
        outline: outline ? JSON.stringify(outline.content) : '暂无大纲',
        retrievedMaterials: grounding.materials,
        assignedEvidenceIds: grounding.evidenceIds,
        wordCount:
          typeof input.word_count === 'number' ? input.word_count : 2000,
        strictCitation,
        stylePrompt,
      };
      return {
        chainType: 'content',
        chainInput,
        authoringContext: authoringContext(chainInput),
      };
    }

    const resultId = requireWorkflowString(input, 'result_id');
    const original = await this.getWritingResult(userId, projectId, resultId);
    if (workflowType === 'rewrite') {
      const instruction = requireWorkflowString(input, 'instruction');
      const query =
        typeof input.additional_context === 'string' &&
        input.additional_context.trim() !== ''
          ? input.additional_context
          : instruction;
      const grounding = assignedGrounding
        ? assignedGrounding
        : trace?.workflow_job_id
          ? await this.contentSharedService.retrieveGroundingMaterials(
              projectId,
              query,
              trace.workflow_job_id,
              input.strict_citation !== false,
            )
          : {
              materials: await this.contentSharedService.retrieveMaterials(
                projectId,
                query,
              ),
              evidenceIds: [] as string[],
            };
      const chainInput = {
        originalContent: original.content_text ?? '',
        instruction,
        retrievedMaterials: grounding.materials,
        assignedEvidenceIds: grounding.evidenceIds,
      };
      return {
        chainType: 'rewrite',
        chainInput,
        authoringContext: authoringContext(chainInput),
      };
    }
    if (workflowType === 'expand') {
      const query = original.section_node_id ?? '';
      const grounding = assignedGrounding
        ? assignedGrounding
        : trace?.workflow_job_id
          ? await this.contentSharedService.retrieveGroundingMaterials(
              projectId,
              query,
              trace.workflow_job_id,
              input.strict_citation !== false,
            )
          : {
              materials: await this.contentSharedService.retrieveMaterials(
                projectId,
                query,
              ),
              evidenceIds: [] as string[],
            };
      const chainInput = {
        originalContent: original.content_text ?? '',
        targetWordCount:
          typeof input.target_word_count === 'number'
            ? input.target_word_count
            : 3000,
        retrievedMaterials: grounding.materials,
        assignedEvidenceIds: grounding.evidenceIds,
      };
      return {
        chainType: 'expand',
        chainInput,
        authoringContext: authoringContext(chainInput),
      };
    }
    if (!trace?.workflow_job_id) {
      throw new BadRequestException('精简工作流缺少持久任务标识');
    }
    const grounding =
      assignedGrounding ??
      (await this.contentSharedService.inheritGroundingMaterials(
        projectId,
        trace.workflow_job_id,
        resultId,
        input.strict_citation !== false,
      ));
    const chainInput = {
      originalContent: original.content_text ?? '',
      targetWordCount:
        typeof input.target_word_count === 'number'
          ? input.target_word_count
          : 1000,
      retrievedMaterials: grounding.materials,
      assignedEvidenceIds: grounding.evidenceIds,
    };
    return {
      chainType: 'compress',
      chainInput,
      authoringContext: authoringContext(chainInput),
    };
  }

  async prepareGroundingRevision(
    userId: string,
    projectId: string,
    workflowJobId: string,
    unsupportedClaims: Array<{ claim_id: string; claim_text: string }>,
    signal: AbortSignal,
    baseRetrievalRunId?: string,
  ): Promise<void> {
    await this.projectService.findOne(userId, projectId);
    await this.contentSharedService.retrieveRevisionGroundingMaterials(
      projectId,
      workflowJobId,
      unsupportedClaims,
      signal,
      baseRetrievalRunId,
    );
  }

  async *generateGroundingRevision(
    userId: string,
    projectId: string,
    workflowJobId: string,
    originalOutput: string,
    unsupportedClaims: Array<{ claim_id: string; claim_text: string }>,
    signal: AbortSignal,
    trace: ModelTraceMetadata,
  ): AsyncGenerator<string> {
    await this.projectService.findOne(userId, projectId);
    const grounding = await this.contentSharedService.loadGroundingMaterials(
      projectId,
      workflowJobId,
    );
    const targets = unsupportedClaims
      .map((claim) => `- ${claim.claim_text}`)
      .join('\n');
    yield* this.agentService.generateStream(
      'rewrite',
      {
        originalContent: originalOutput,
        instruction:
          '只修订下列不受支持声明，保持其他结构、段落和含义不变；不得增加新事实：\n' +
          targets,
        retrievedMaterials: grounding.materials,
        assignedEvidenceIds: grounding.evidenceIds,
      },
      { signal, trace },
    );
  }

  async *generateContent(
    userId: string,
    projectId: string,
    dto: GenerateContentDto,
    signal?: AbortSignal,
  ): AsyncGenerator<{ type: string; data: any }> {
    const project = await this.projectService.findOne(userId, projectId);
    const template =
      await this.styleTemplateService.getProjectActiveTemplate(projectId);
    if (!template || !template.features) {
      throw new ConflictException('请先上传并分析体例文件');
    }

    const writingResult = this.writingResultRepo.create({
      project_id: projectId,
      chapter_node_id: dto.chapter_node_id,
      section_node_id: dto.section_node_id,
      task_type: TaskType.GENERATE,
      status: WritingResultStatus.STREAMING,
      content_text: '',
    });
    const saved = await this.writingResultRepo.save(writingResult);

    yield {
      type: 'meta',
      data: {
        type: 'meta',
        result_id: saved.id,
        task_type: TaskType.GENERATE,
        started_at: saved.created_at.toISOString(),
      },
    };

    let fullContent = '';
    try {
      const outline = await this.getCurrentOutline(
        projectId,
        dto.chapter_node_id,
      );
      const outlineText = outline
        ? JSON.stringify(outline.content)
        : '暂无大纲';
      const materials = await this.contentSharedService.retrieveMaterials(
        projectId,
        [dto.chapter_title, dto.section_title].filter(Boolean).join(' ') ||
          project.name,
      );
      const stylePrompt =
        await this.contentSharedService.getStructureTreePrompt(
          projectId,
          'content',
        );

      const stream = this.agentService.generateStream(
        'content',
        {
          projectName: project.name,
          style: dto.style ?? project.style,
          chapterTitle: dto.chapter_title ?? dto.chapter_node_id,
          sectionTitle: dto.section_title ?? dto.section_node_id,
          outline: outlineText,
          retrievedMaterials: materials,
          wordCount: dto.word_count ?? 2000,
          strictCitation: dto.strict_citation ?? true,
          stylePrompt,
        },
        { signal },
      );

      for await (const token of stream) {
        fullContent += token;
        yield { type: 'token', data: { type: 'token', content: token } };
      }

      fullContent = normalizeGeneratedContent(fullContent);

      await this.writingResultRepo.update(
        { id: saved.id, project_id: projectId },
        {
          status: WritingResultStatus.SUCCEEDED,
          content_text: fullContent,
          word_count: fullContent.length,
        },
      );
      await this.storeContentVersion(saved.id, fullContent);
      const citations = await this.persistStructuredCitations(
        userId,
        projectId,
        saved.id,
        fullContent,
      );

      if (citations.length > 0) {
        const grouped = new Map<string, any[]>();
        for (const citation of citations) {
          const key = citation.paragraph_key || 'p0';
          const current = grouped.get(key) ?? [];
          current.push(citation);
          grouped.set(key, current);
        }
        for (const [paragraph_key, items] of grouped) {
          yield {
            type: 'citation',
            data: { type: 'citation', paragraph_key, citations: items },
          };
        }
      }

      yield {
        type: 'done',
        data: {
          type: 'done',
          result_id: saved.id,
          status: WritingResultStatus.SUCCEEDED,
          citations,
        },
      };
    } catch (err: unknown) {
      const cancelled = signal?.aborted === true;
      await this.writingResultRepo.update(
        { id: saved.id, project_id: projectId },
        {
          status: cancelled
            ? WritingResultStatus.STOPPED
            : WritingResultStatus.FAILED,
          content_text: fullContent || '',
          ...(cancelled ? { completed_at: new Date() } : {}),
        },
      );
      yield {
        type: 'error',
        data: {
          type: 'error',
          message: cancelled
            ? '生成已取消'
            : this.getErrorMessage(err, '生成失败'),
          error_code: cancelled ? 'GENERATION_CANCELLED' : 'GENERATION_FAILED',
        },
      };
    }
  }

  async *rewriteContent(
    userId: string,
    projectId: string,
    resultId: string,
    dto: RewriteContentDto,
    signal?: AbortSignal,
  ): AsyncGenerator<{ type: string; data: any }> {
    await this.projectService.findOne(userId, projectId);
    const original = await this.getWritingResult(userId, projectId, resultId);

    const writingResult = await this.writingResultRepo.save(
      this.writingResultRepo.create({
        project_id: projectId,
        chapter_node_id: original.chapter_node_id,
        section_node_id: original.section_node_id,
        task_type: TaskType.REWRITE,
        status: WritingResultStatus.STREAMING,
        content_text: '',
        parent_result_id: resultId,
      }),
    );

    yield {
      type: 'meta',
      data: {
        type: 'meta',
        result_id: writingResult.id,
        task_type: TaskType.REWRITE,
        started_at: writingResult.created_at.toISOString(),
      },
    };

    let fullContent = '';
    try {
      const materials = dto.additional_context
        ? await this.contentSharedService.retrieveMaterials(
            projectId,
            dto.additional_context,
          )
        : '';

      const stream = this.agentService.generateStream(
        'rewrite',
        {
          originalContent: original.content_text ?? '',
          instruction: dto.instruction,
          retrievedMaterials: materials,
        },
        { signal },
      );

      for await (const token of stream) {
        fullContent += token;
        yield { type: 'token', data: { type: 'token', content: token } };
      }

      fullContent = normalizeGeneratedContent(fullContent);

      await this.writingResultRepo.update(
        { id: writingResult.id, project_id: projectId },
        {
          status: WritingResultStatus.SUCCEEDED,
          content_text: fullContent,
          word_count: fullContent.length,
        },
      );
      await this.storeContentVersion(writingResult.id, fullContent);
      const citations = await this.persistStructuredCitations(
        userId,
        projectId,
        writingResult.id,
        fullContent,
      );

      yield {
        type: 'done',
        data: {
          type: 'done',
          result_id: writingResult.id,
          status: WritingResultStatus.SUCCEEDED,
          citations,
        },
      };
    } catch (err: unknown) {
      const cancelled = signal?.aborted === true;
      await this.writingResultRepo.update(
        { id: writingResult.id, project_id: projectId },
        {
          status: cancelled
            ? WritingResultStatus.STOPPED
            : WritingResultStatus.FAILED,
          content_text: fullContent || '',
          ...(cancelled ? { completed_at: new Date() } : {}),
        },
      );
      yield {
        type: 'error',
        data: {
          type: 'error',
          message: cancelled
            ? '重写已取消'
            : this.getErrorMessage(err, '重写失败'),
          error_code: cancelled ? 'GENERATION_CANCELLED' : 'REWRITE_FAILED',
        },
      };
    }
  }

  async *expandContent(
    userId: string,
    projectId: string,
    resultId: string,
    dto: ExpandContentDto,
    signal?: AbortSignal,
  ): AsyncGenerator<{ type: string; data: any }> {
    await this.projectService.findOne(userId, projectId);
    const original = await this.getWritingResult(userId, projectId, resultId);

    const writingResult = await this.writingResultRepo.save(
      this.writingResultRepo.create({
        project_id: projectId,
        chapter_node_id: original.chapter_node_id,
        section_node_id: original.section_node_id,
        task_type: TaskType.EXPAND,
        status: WritingResultStatus.STREAMING,
        content_text: '',
        parent_result_id: resultId,
      }),
    );

    yield {
      type: 'meta',
      data: {
        type: 'meta',
        result_id: writingResult.id,
        task_type: TaskType.EXPAND,
        started_at: writingResult.created_at.toISOString(),
      },
    };

    let fullContent = '';
    try {
      const materials = await this.contentSharedService.retrieveMaterials(
        projectId,
        original.section_node_id ?? '',
      );

      const stream = this.agentService.generateStream(
        'expand',
        {
          originalContent: original.content_text ?? '',
          targetWordCount: dto.target_word_count ?? 3000,
          retrievedMaterials: materials,
        },
        { signal },
      );

      for await (const token of stream) {
        fullContent += token;
        yield { type: 'token', data: { type: 'token', content: token } };
      }

      fullContent = normalizeGeneratedContent(fullContent);

      await this.writingResultRepo.update(
        { id: writingResult.id, project_id: projectId },
        {
          status: WritingResultStatus.SUCCEEDED,
          content_text: fullContent,
          word_count: fullContent.length,
        },
      );
      await this.storeContentVersion(writingResult.id, fullContent);
      const citations = await this.persistStructuredCitations(
        userId,
        projectId,
        writingResult.id,
        fullContent,
      );

      yield {
        type: 'done',
        data: {
          type: 'done',
          result_id: writingResult.id,
          status: WritingResultStatus.SUCCEEDED,
          citations,
        },
      };
    } catch (err: unknown) {
      const cancelled = signal?.aborted === true;
      await this.writingResultRepo.update(
        { id: writingResult.id, project_id: projectId },
        {
          status: cancelled
            ? WritingResultStatus.STOPPED
            : WritingResultStatus.FAILED,
          content_text: fullContent || '',
          ...(cancelled ? { completed_at: new Date() } : {}),
        },
      );
      yield {
        type: 'error',
        data: {
          type: 'error',
          message: cancelled
            ? '扩写已取消'
            : this.getErrorMessage(err, '扩写失败'),
          error_code: cancelled ? 'GENERATION_CANCELLED' : 'EXPAND_FAILED',
        },
      };
    }
  }

  async *compressContent(
    userId: string,
    projectId: string,
    resultId: string,
    dto: CompressContentDto,
    signal?: AbortSignal,
  ): AsyncGenerator<{ type: string; data: any }> {
    await this.projectService.findOne(userId, projectId);
    const original = await this.getWritingResult(userId, projectId, resultId);

    const writingResult = await this.writingResultRepo.save(
      this.writingResultRepo.create({
        project_id: projectId,
        chapter_node_id: original.chapter_node_id,
        section_node_id: original.section_node_id,
        task_type: TaskType.COMPRESS,
        status: WritingResultStatus.STREAMING,
        content_text: '',
        parent_result_id: resultId,
      }),
    );

    yield {
      type: 'meta',
      data: {
        type: 'meta',
        result_id: writingResult.id,
        task_type: TaskType.COMPRESS,
        started_at: writingResult.created_at.toISOString(),
      },
    };

    let fullContent = '';
    try {
      const stream = this.agentService.generateStream(
        'compress',
        {
          originalContent: original.content_text ?? '',
          targetWordCount: dto.target_word_count ?? 1000,
        },
        { signal },
      );

      for await (const token of stream) {
        fullContent += token;
        yield { type: 'token', data: { type: 'token', content: token } };
      }

      fullContent = normalizeGeneratedContent(fullContent);

      await this.writingResultRepo.update(
        { id: writingResult.id, project_id: projectId },
        {
          status: WritingResultStatus.SUCCEEDED,
          content_text: fullContent,
          word_count: fullContent.length,
        },
      );
      await this.storeContentVersion(writingResult.id, fullContent);
      const citations = await this.persistStructuredCitations(
        userId,
        projectId,
        writingResult.id,
        fullContent,
      );

      yield {
        type: 'done',
        data: {
          type: 'done',
          result_id: writingResult.id,
          status: WritingResultStatus.SUCCEEDED,
          citations,
        },
      };
    } catch (err: unknown) {
      const cancelled = signal?.aborted === true;
      await this.writingResultRepo.update(
        { id: writingResult.id, project_id: projectId },
        {
          status: cancelled
            ? WritingResultStatus.STOPPED
            : WritingResultStatus.FAILED,
          content_text: fullContent || '',
          ...(cancelled ? { completed_at: new Date() } : {}),
        },
      );
      yield {
        type: 'error',
        data: {
          type: 'error',
          message: cancelled
            ? '精简已取消'
            : this.getErrorMessage(err, '精简失败'),
          error_code: cancelled ? 'GENERATION_CANCELLED' : 'COMPRESS_FAILED',
        },
      };
    }
  }

  async stopGeneration(
    userId: string,
    projectId: string,
    resultId: string,
  ): Promise<WritingResult> {
    await this.projectService.findOne(userId, projectId);
    const result = await this.writingResultRepo.findOne({
      where: { id: resultId, project_id: projectId },
    });
    if (!result) throw new NotFoundException('写作结果不存在');
    if (result.status !== WritingResultStatus.STREAMING) return result;
    await this.writingResultRepo.update(
      { id: result.id, project_id: projectId },
      {
        status: WritingResultStatus.STOPPED,
        completed_at: new Date(),
      },
    );
    return this.writingResultRepo.findOneOrFail({
      where: { id: result.id, project_id: projectId },
    });
  }

  async getWritingResult(
    userId: string,
    projectId: string,
    resultId: string,
  ): Promise<WritingResult> {
    await this.projectService.findOne(userId, projectId);
    const result = await this.writingResultRepo.findOne({
      where: { id: resultId, project_id: projectId },
    });
    if (!result) throw new NotFoundException('写作结果不存在');
    return result;
  }

  async getLatestResultBySection(
    userId: string,
    projectId: string,
    sectionNodeId: string,
  ): Promise<WritingResult | null> {
    await this.projectService.findOne(userId, projectId);
    return this.writingResultRepo.findOne({
      where: { project_id: projectId, section_node_id: sectionNodeId },
      order: { created_at: 'DESC' },
    });
  }

  async updateWritingResult(
    userId: string,
    projectId: string,
    id: string,
    content: string,
  ): Promise<WritingResult> {
    await this.projectService.findOne(userId, projectId);
    const result = await this.writingResultRepo.findOne({
      where: { id, project_id: projectId },
    });
    if (!result) throw new NotFoundException('写作结果不存在');
    await this.writingResultRepo.update(
      { id, project_id: projectId },
      { content_text: content },
    );
    return this.writingResultRepo.findOneOrFail({
      where: { id, project_id: projectId },
    });
  }
}

function authoringContext(input: ChainInput): Record<string, unknown> {
  const {
    retrievedMaterials: _retrievedMaterials,
    assignedEvidenceIds: _assignedEvidenceIds,
    ...context
  } = input as ChainInput & {
    retrievedMaterials?: unknown;
    assignedEvidenceIds?: unknown;
  };
  void _retrievedMaterials;
  void _assignedEvidenceIds;
  return context;
}

function requireWorkflowString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConflictException(`工作流字段 ${key} 不能为空`);
  }
  return value;
}
