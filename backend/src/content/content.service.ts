import { Injectable, Logger } from '@nestjs/common';
import { DirectoryService } from './directory.service.js';
import { OutlineService } from './outline.service.js';
import { ContentGenerationService } from './content-generation.service.js';
import { WritingResult } from './entities/writing-result.entity.js';
import { DirectoryVersion } from './entities/directory-version.entity.js';
import { OutlineVersion } from './entities/outline-version.entity.js';
import { GenerateDirectoryDto } from './dto/generate-directory.dto.js';
import { GenerateOutlineDto } from './dto/generate-outline.dto.js';
import { GenerateContentDto } from './dto/generate-content.dto.js';
import { RewriteContentDto } from './dto/rewrite-content.dto.js';
import { ExpandContentDto } from './dto/expand-content.dto.js';
import { CompressContentDto } from './dto/compress-content.dto.js';
import { SaveDirectoryDto } from './dto/save-directory.dto.js';
import { SaveOutlineDto } from './dto/save-outline.dto.js';
import { OutlineContentDto } from './dto/save-outline.dto.js';
import { ProjectService } from '../project/project.service.js';
import type { ModelTraceMetadata } from '../llm/model-types.js';
import {
  AtomicGroundingCoordinator,
  type AtomicGroundingOutcome,
  type PreparedAtomicGroundingGeneration,
} from '../citation/atomic-grounding/atomic-grounding-coordinator.service.js';
import type { SealedGroundedCandidateV1 } from '../citation/atomic-grounding/contracts.js';
import type { ModelOperationIdentity } from '../llm/model-types.js';

/**
 * ContentService — facade that delegates to domain services.
 * Controller and external consumers continue to use this class unchanged.
 */
@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    private readonly directoryService: DirectoryService,
    private readonly outlineService: OutlineService,
    private readonly contentGenerationService: ContentGenerationService,
    private readonly projectService: ProjectService,
    private readonly atomicGroundingCoordinator: AtomicGroundingCoordinator,
  ) {}

  async assertProjectOwner(userId: string, projectId: string) {
    return this.projectService.findOne(userId, projectId);
  }

  // ── Directory ──────────────────────────────────────────────────────────────

  async *generateDirectory(
    userId: string,
    projectId: string,
    dto: GenerateDirectoryDto,
    signal?: AbortSignal,
    trace?: ModelTraceMetadata,
  ): AsyncGenerator<string> {
    yield* this.directoryService.generateDirectory(
      userId,
      projectId,
      dto,
      signal,
      trace,
    );
  }

  async getDirectoryVersions(userId: string, projectId: string) {
    return this.directoryService.getDirectoryVersions(userId, projectId);
  }

  async getCurrentDirectory(userId: string, projectId: string) {
    return this.directoryService.getCurrentDirectory(userId, projectId);
  }

  async getDirectoryVersion(
    userId: string,
    projectId: string,
    versionId: string,
  ) {
    return this.directoryService.getDirectoryVersion(
      userId,
      projectId,
      versionId,
    );
  }

  async saveDirectory(
    userId: string,
    projectId: string,
    dto: SaveDirectoryDto,
  ) {
    return this.directoryService.saveDirectory(userId, projectId, dto);
  }

  async updateDirectoryNode(
    userId: string,
    projectId: string,
    nodeId: string,
    title: string,
  ): Promise<DirectoryVersion> {
    return this.directoryService.updateDirectoryNode(
      userId,
      projectId,
      nodeId,
      title,
    );
  }

  async deleteDirectoryNode(
    userId: string,
    projectId: string,
    nodeId: string,
  ): Promise<void> {
    return this.directoryService.deleteDirectoryNode(userId, projectId, nodeId);
  }

  // ── Outline ────────────────────────────────────────────────────────────────

  async *generateOutline(
    userId: string,
    projectId: string,
    dto: GenerateOutlineDto,
    signal?: AbortSignal,
    trace?: ModelTraceMetadata,
  ): AsyncGenerator<string> {
    yield* this.outlineService.generateOutline(
      userId,
      projectId,
      dto,
      signal,
      trace,
    );
  }

  async getOutline(userId: string, projectId: string, outlineId: string) {
    return this.outlineService.getOutline(userId, projectId, outlineId);
  }

  async saveOutlineFromGeneration(
    userId: string,
    projectId: string,
    dto: GenerateOutlineDto,
    rawContent: string,
  ) {
    return this.outlineService.saveOutlineFromGeneration(
      userId,
      projectId,
      dto,
      rawContent,
    );
  }

  async saveOutline(userId: string, projectId: string, dto: SaveOutlineDto) {
    return this.outlineService.saveOutline(userId, projectId, dto);
  }

  async getLatestOutlineByChapter(
    userId: string,
    projectId: string,
    chapterNodeId: string,
    sectionNodeId?: string,
  ) {
    return this.outlineService.getLatestOutlineByChapter(
      userId,
      projectId,
      chapterNodeId,
      sectionNodeId,
    );
  }

  async updateOutline(
    userId: string,
    projectId: string,
    id: string,
    content: OutlineContentDto,
  ): Promise<OutlineVersion> {
    return this.outlineService.updateOutline(userId, projectId, id, content);
  }

  // ── Content generation ─────────────────────────────────────────────────────

  async *generateWorkflowText(
    workflowType: 'content' | 'rewrite' | 'expand' | 'compress',
    userId: string,
    projectId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    trace?: ModelTraceMetadata,
  ): AsyncGenerator<string> {
    yield* this.contentGenerationService.generateWorkflowText(
      workflowType,
      userId,
      projectId,
      input,
      signal,
      trace,
    );
  }

  async generateAtomicGroundingCandidate(
    workflowType: 'content' | 'rewrite' | 'expand' | 'compress',
    userId: string,
    projectId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    trace: ModelTraceMetadata,
  ): Promise<AtomicGroundingOutcome> {
    const prepared =
      await this.contentGenerationService.prepareAtomicGroundingInput(
        workflowType,
        userId,
        projectId,
        input,
        signal,
        trace,
      );
    return this.atomicGroundingCoordinator.generate(prepared);
  }

  async generateAtomicGroundingRevisionCandidate(
    workflowType: 'content' | 'rewrite' | 'expand' | 'compress',
    userId: string,
    projectId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    trace: ModelTraceMetadata,
    persistSealedCandidate?: (
      candidate: SealedGroundedCandidateV1,
    ) => Promise<void>,
  ): Promise<AtomicGroundingOutcome> {
    const prepared =
      await this.contentGenerationService.prepareAtomicGroundingRevisionInput(
        workflowType,
        userId,
        projectId,
        input,
        signal,
        trace,
        persistSealedCandidate,
      );
    return this.atomicGroundingCoordinator.generate(prepared);
  }

  async prepareAtomicGroundingRevisionModel(
    workflowType: 'content' | 'rewrite' | 'expand' | 'compress',
    userId: string,
    projectId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    trace: ModelTraceMetadata,
    persistSealedCandidate?: (
      candidate: SealedGroundedCandidateV1,
    ) => Promise<void>,
  ): Promise<PreparedAtomicGroundingGeneration> {
    const generationInput =
      await this.contentGenerationService.prepareAtomicGroundingRevisionInput(
        workflowType,
        userId,
        projectId,
        input,
        signal,
        trace,
        persistSealedCandidate,
      );
    return this.atomicGroundingCoordinator.prepareRevisionModel(
      generationInput,
    );
  }

  executePreparedAtomicGroundingRevisionModel(
    prepared: PreparedAtomicGroundingGeneration,
  ): Promise<AtomicGroundingOutcome> {
    return this.atomicGroundingCoordinator.executePreparedRevision(prepared);
  }

  async recoverAtomicGroundingCandidate(
    workflowJobId: string,
    projectId: string,
    checkpoint: unknown,
  ): Promise<AtomicGroundingOutcome> {
    return this.atomicGroundingCoordinator.recover({
      workflow_job_id: workflowJobId,
      project_id: projectId,
      checkpoint,
    });
  }

  async inspectAtomicGroundingRevisionModelAttempt(
    workflowJobId: string,
    operation: string | ModelOperationIdentity,
  ): Promise<'absent' | 'recorded' | 'mismatch' | 'unknown'> {
    return this.atomicGroundingCoordinator.inspectRevisionModelAttempt(
      workflowJobId,
      operation,
    );
  }

  async prepareGroundingRevision(
    userId: string,
    projectId: string,
    workflowJobId: string,
    unsupportedClaims: Array<{ claim_id: string; claim_text: string }>,
    signal: AbortSignal,
    baseRetrievalRunId?: string,
  ): Promise<void> {
    await this.contentGenerationService.prepareGroundingRevision(
      userId,
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
    yield* this.contentGenerationService.generateGroundingRevision(
      userId,
      projectId,
      workflowJobId,
      originalOutput,
      unsupportedClaims,
      signal,
      trace,
    );
  }

  async *generateContent(
    userId: string,
    projectId: string,
    dto: GenerateContentDto,
    signal?: AbortSignal,
  ): AsyncGenerator<{ type: string; data: any }> {
    yield* this.contentGenerationService.generateContent(
      userId,
      projectId,
      dto,
      signal,
    );
  }

  async *rewriteContent(
    userId: string,
    projectId: string,
    resultId: string,
    dto: RewriteContentDto,
    signal?: AbortSignal,
  ): AsyncGenerator<{ type: string; data: any }> {
    yield* this.contentGenerationService.rewriteContent(
      userId,
      projectId,
      resultId,
      dto,
      signal,
    );
  }

  async *expandContent(
    userId: string,
    projectId: string,
    resultId: string,
    dto: ExpandContentDto,
    signal?: AbortSignal,
  ): AsyncGenerator<{ type: string; data: any }> {
    yield* this.contentGenerationService.expandContent(
      userId,
      projectId,
      resultId,
      dto,
      signal,
    );
  }

  async *compressContent(
    userId: string,
    projectId: string,
    resultId: string,
    dto: CompressContentDto,
    signal?: AbortSignal,
  ): AsyncGenerator<{ type: string; data: any }> {
    yield* this.contentGenerationService.compressContent(
      userId,
      projectId,
      resultId,
      dto,
      signal,
    );
  }

  async stopGeneration(
    userId: string,
    projectId: string,
    resultId: string,
  ): Promise<WritingResult> {
    return this.contentGenerationService.stopGeneration(
      userId,
      projectId,
      resultId,
    );
  }

  async getWritingResult(userId: string, projectId: string, resultId: string) {
    return this.contentGenerationService.getWritingResult(
      userId,
      projectId,
      resultId,
    );
  }

  async getLatestResultBySection(
    userId: string,
    projectId: string,
    sectionNodeId: string,
  ) {
    return this.contentGenerationService.getLatestResultBySection(
      userId,
      projectId,
      sectionNodeId,
    );
  }

  async updateWritingResult(
    userId: string,
    projectId: string,
    id: string,
    content: string,
  ): Promise<WritingResult> {
    return this.contentGenerationService.updateWritingResult(
      userId,
      projectId,
      id,
      content,
    );
  }
}
