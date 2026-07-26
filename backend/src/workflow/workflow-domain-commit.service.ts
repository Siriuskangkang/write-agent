import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager, DataSource } from 'typeorm';
import {
  CitationUseType,
  TaskType,
  WritingResultStatus,
} from '../common/enums.js';
import type { DirectoryNodeDto } from '../content/dto/save-directory.dto.js';
import { normalizeGeneratedContent } from '../content/utils/normalize-generated-content.js';
import type { ClaimedWorkflowJob } from './workflow.engine.js';
import {
  WorkflowCancelledError,
  WorkflowLeaseLostError,
} from './workflow.engine.js';
import { WorkflowStatus, WorkflowType } from './workflow.types.js';
import { CitationLedgerService } from '../citation/citation-ledger.service.js';
import type { GroundingVerificationResult } from '../citation/grounding-verifier.js';
import type { SealedGroundedCandidateV1 } from '../citation/atomic-grounding/contracts.js';
import { AtomicGroundingExecutionFailure } from '../citation/atomic-grounding/failure-policy.js';

export type WorkflowDomainCommitInput =
  | {
      contract_version: 'legacy:v0';
      output: string;
      directoryNodes?: DirectoryNodeDto[];
    }
  | {
      contract_version: 'atomic:v1';
      sealed_candidate: SealedGroundedCandidateV1;
    };

type LegacyWorkflowDomainCommitInput = Extract<
  WorkflowDomainCommitInput,
  { contract_version: 'legacy:v0' }
>;

export class AtomicCommitNotAuthorizedError extends AtomicGroundingExecutionFailure {
  readonly code = 'ATOMIC_COMMIT_NOT_AUTHORIZED';
  readonly public_code = 'ATOMIC_COMMIT_NOT_AUTHORIZED';

  constructor() {
    super('ATOMIC_COMMIT_NOT_AUTHORIZED', 0);
    this.name = 'AtomicCommitNotAuthorizedError';
  }
}

export interface WorkflowDomainCommitResult {
  resourceId: string;
  versionId?: string;
  citations?: Array<Record<string, unknown>>;
}

interface LockedWorkflowRow {
  status: WorkflowStatus;
  cancel_requested_at: Date | string | null;
  lease_token: string | null;
  fencing_token: number | string;
  lease_active: number | string;
}

interface DomainCommitRow {
  resource_id: string;
  version_id: string | null;
  commit_payload: Record<string, unknown> | string | null;
}

@Injectable()
export class WorkflowDomainCommitService {
  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly citationLedger?: CitationLedgerService,
  ) {}

  async commit(
    job: ClaimedWorkflowJob,
    input: WorkflowDomainCommitInput,
  ): Promise<WorkflowDomainCommitResult> {
    if (input.contract_version === 'atomic:v1') {
      throw new AtomicCommitNotAuthorizedError();
    }
    const alreadyCommitted = await this.findCommitted(job.id);
    if (alreadyCommitted) return alreadyCommitted;
    // Model-backed semantic review must run before the transaction locks the
    // workflow row. Ledger persistence revalidates active evidence inside the
    // commit transaction.
    const grounding = await this.prepareGrounding(job, input.output);
    return this.dataSource.transaction(async (manager) => {
      const workflow = await this.lockWorkflow(manager, job.id);
      this.assertFence(workflow, job);

      const existing = await this.findCommit(manager, job.id);
      if (existing) {
        return this.domainCommitResult(manager, existing);
      }

      const committed = await this.commitDomain(
        manager,
        job,
        input,
        grounding !== null,
      );
      if (grounding && this.citationLedger) {
        await this.citationLedger.persist(
          manager,
          committed.resourceId,
          grounding,
        );
        committed.citations = grounding.claims.flatMap((claim) =>
          claim.links.map((link) => ({
            claim_id: claim.claim_id,
            evidence_id: link.evidence_id,
            support_status: claim.support_status,
            support_score: claim.support_score,
          })),
        );
      }
      await manager.query(
        `INSERT INTO workflow_domain_commits
           (workflow_job_id, workflow_type, resource_id, version_id,
            fencing_token, commit_payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          job.workflowType,
          committed.resourceId,
          committed.versionId ?? null,
          job.fencingToken,
          JSON.stringify(committed),
        ],
      );
      return committed;
    });
  }

  async findCommitted(
    jobId: string,
  ): Promise<WorkflowDomainCommitResult | null> {
    const rows: unknown = await this.dataSource.query(
      `SELECT resource_id, version_id, commit_payload
         FROM workflow_domain_commits
        WHERE workflow_job_id = ?`,
      [jobId],
    );
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    return this.domainCommitResult(
      this.dataSource.manager,
      rows[0] as DomainCommitRow,
    );
  }

  private async commitDomain(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
    input: LegacyWorkflowDomainCommitInput,
    hasGroundingLedger: boolean,
  ): Promise<WorkflowDomainCommitResult> {
    switch (job.workflowType) {
      case WorkflowType.DIRECTORY:
        return this.commitDirectory(manager, job, input);
      case WorkflowType.OUTLINE:
        return this.commitOutline(manager, job, input.output);
      case WorkflowType.CONTENT:
      case WorkflowType.REWRITE:
      case WorkflowType.EXPAND:
      case WorkflowType.COMPRESS:
        return this.commitContent(
          manager,
          job,
          input.output,
          hasGroundingLedger,
        );
      default:
        throw new BadRequestException(
          `当前 worker 尚不支持 ${job.workflowType} 工作流`,
        );
    }
  }

  private async commitDirectory(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
    input: LegacyWorkflowDomainCommitInput,
  ): Promise<WorkflowDomainCommitResult> {
    if (!input.directoryNodes || input.directoryNodes.length === 0) {
      throw new BadRequestException('目录格式错误：缺少 nodes 字段');
    }
    await manager.query(
      `UPDATE directory_versions
          SET is_current = 0
        WHERE project_id = ?
          AND is_current = 1`,
      [job.projectId],
    );
    const versionNumber = await this.nextVersion(
      manager,
      'directory_versions',
      'project_id = ?',
      [job.projectId],
    );
    const versionId = randomUUID();
    await manager.query(
      `INSERT INTO directory_versions
         (id, project_id, version_number, content, is_current)
       VALUES (?, ?, ?, ?, 1)`,
      [
        versionId,
        job.projectId,
        versionNumber,
        JSON.stringify(input.directoryNodes),
      ],
    );
    const stateResult: unknown = await manager.query(
      `UPDATE project_states
          SET current_directory_version_id = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ?`,
      [versionId, job.projectId],
    );
    if (affectedRows(stateResult) !== 1) {
      throw new WorkflowLeaseLostError();
    }
    return { resourceId: versionId, versionId };
  }

  private async commitOutline(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
    rawOutput: string,
  ): Promise<WorkflowDomainCommitResult> {
    const input = requireInput(job);
    const chapterNodeId = requireString(input, 'chapter_node_id');
    const chapterTitle = requireString(input, 'chapter_title');
    const sectionNodeId = optionalString(input, 'section_node_id');
    const content = parseGeneratedObject(rawOutput, '大纲内容解析失败');

    await manager.query(
      `UPDATE outline_versions
          SET is_current = 0
        WHERE project_id = ?
          AND chapter_node_id = ?
          AND COALESCE(section_node_id, '') = ?
          AND is_current = 1`,
      [job.projectId, chapterNodeId, sectionNodeId ?? ''],
    );
    const versionNumber = await this.nextVersion(
      manager,
      'outline_versions',
      `project_id = ?
       AND chapter_node_id = ?
       AND COALESCE(section_node_id, '') = ?`,
      [job.projectId, chapterNodeId, sectionNodeId ?? ''],
    );
    const chapterIndex = await this.findChapterIndex(
      manager,
      job.projectId,
      chapterNodeId,
    );
    const versionId = randomUUID();
    await manager.query(
      `INSERT INTO outline_versions
         (id, project_id, chapter_node_id, section_node_id, chapter_index,
          chapter_title, version_number, content, is_current)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        versionId,
        job.projectId,
        chapterNodeId,
        sectionNodeId,
        chapterIndex,
        chapterTitle,
        versionNumber,
        JSON.stringify(content),
      ],
    );
    return { resourceId: versionId, versionId };
  }

  private async commitContent(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
    rawOutput: string,
    hasGroundingLedger: boolean,
  ): Promise<WorkflowDomainCommitResult> {
    const input = requireInput(job);
    const output = normalizeGeneratedContent(rawOutput);
    const resultId = randomUUID();
    const contentVersionId = randomUUID();
    const parentId =
      job.workflowType === WorkflowType.CONTENT
        ? null
        : requireString(input, 'result_id');
    let chapterNodeId = optionalString(input, 'chapter_node_id');
    let sectionNodeId = optionalString(input, 'section_node_id');
    let chapterTitle = optionalString(input, 'chapter_title');
    let sectionTitle = optionalString(input, 'section_title');

    if (parentId) {
      const parents: unknown = await manager.query(
        `SELECT chapter_node_id, section_node_id, chapter_title, section_title
           FROM writing_results
          WHERE id = ?
            AND project_id = ?
          FOR UPDATE`,
        [parentId, job.projectId],
      );
      if (!Array.isArray(parents) || parents.length !== 1) {
        throw new BadRequestException('原写作结果不存在');
      }
      const parent = parents[0] as Record<string, unknown>;
      chapterNodeId = optionalRowString(parent.chapter_node_id);
      sectionNodeId = optionalRowString(parent.section_node_id);
      chapterTitle = optionalRowString(parent.chapter_title);
      sectionTitle = optionalRowString(parent.section_title);
    }

    await manager.query(
      `INSERT INTO writing_results
         (id, project_id, session_id, chapter_node_id, section_node_id,
          chapter_title, section_title, task_type, status, content_text,
          word_count, style, version_number, parent_result_id, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?,
               CURRENT_TIMESTAMP)`,
      [
        resultId,
        job.projectId,
        optionalString(input, 'session_id'),
        chapterNodeId,
        sectionNodeId,
        chapterTitle,
        sectionTitle,
        toTaskType(job.workflowType),
        WritingResultStatus.SUCCEEDED,
        output,
        output.length,
        optionalString(input, 'style'),
        parentId,
      ],
    );
    await manager.query(
      `INSERT INTO content_versions
         (id, result_id, version_number, editor_source, content_text,
          is_current)
       VALUES (?, ?, 1, 'ai', ?, 1)`,
      [contentVersionId, resultId, output],
    );
    const citations = hasGroundingLedger
      ? []
      : await this.persistCitations(manager, job.projectId, resultId, output);
    return {
      resourceId: resultId,
      versionId: contentVersionId,
      citations,
    };
  }

  private prepareGrounding(
    job: ClaimedWorkflowJob,
    output: string,
  ): Promise<GroundingVerificationResult | null> {
    if (
      !this.citationLedger ||
      (job.workflowType !== WorkflowType.CONTENT &&
        job.workflowType !== WorkflowType.REWRITE &&
        job.workflowType !== WorkflowType.EXPAND &&
        job.workflowType !== WorkflowType.COMPRESS)
    ) {
      return Promise.resolve(null);
    }
    return this.citationLedger.prepare({
      workflow_job_id: job.id,
      project_id: job.projectId,
      output,
    });
  }

  private async persistCitations(
    manager: EntityManager,
    projectId: string,
    resultId: string,
    content: string,
  ): Promise<Array<Record<string, unknown>>> {
    const parsed = parseCitationMarkers(content);
    if (parsed.length === 0) return [];
    const citations: Array<Record<string, unknown>> = [];
    for (const marker of parsed) {
      const chunks: unknown = await manager.query(
        `SELECT id, file_id, content, page_number, section_title
           FROM chunks
          WHERE id = ?
            AND project_id = ?`,
        [marker.chunkId, projectId],
      );
      if (!Array.isArray(chunks) || chunks.length !== 1) continue;
      const chunk = chunks[0] as Record<string, unknown>;
      const id = randomUUID();
      const rawEvidence =
        typeof chunk.content === 'string' ? chunk.content : marker.description;
      const evidence = rawEvidence.replace(/\s+/g, ' ').trim().slice(0, 300);
      const confidence =
        marker.useType === CitationUseType.UNSUPPORTED ? 0.2 : 0.85;
      await manager.query(
        `INSERT INTO citation_maps
           (id, project_id, result_id, paragraph_key, chunk_id, file_id,
            use_type, evidence_text, page_number, section_title,
            confidence_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          projectId,
          resultId,
          marker.paragraphKey,
          marker.chunkId,
          chunk.file_id,
          marker.useType,
          evidence || marker.description,
          chunk.page_number ?? null,
          chunk.section_title ?? null,
          confidence,
        ],
      );
      citations.push({
        id,
        paragraph_key: marker.paragraphKey,
        chunk_id: marker.chunkId,
        file_id: chunk.file_id,
        use_type: marker.useType,
        evidence_text: evidence || marker.description,
        page_number: chunk.page_number ?? null,
        section_title: chunk.section_title ?? null,
        confidence_score: confidence,
      });
    }
    return citations;
  }

  private async lockWorkflow(
    manager: EntityManager,
    jobId: string,
  ): Promise<LockedWorkflowRow> {
    const rows: unknown = await manager.query(
      `SELECT status, cancel_requested_at, lease_token, fencing_token,
              (lease_expires_at > CURRENT_TIMESTAMP(6)) AS lease_active
         FROM workflow_jobs
        WHERE id = ?
        FOR UPDATE`,
      [jobId],
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new WorkflowLeaseLostError();
    }
    return rows[0] as LockedWorkflowRow;
  }

  private assertFence(row: LockedWorkflowRow, job: ClaimedWorkflowJob): void {
    if (
      row.status === WorkflowStatus.STOPPED ||
      row.cancel_requested_at !== null
    ) {
      throw new WorkflowCancelledError();
    }
    if (
      row.status !== WorkflowStatus.RUNNING ||
      row.lease_token !== job.leaseToken ||
      Number(row.fencing_token) !== job.fencingToken ||
      Number(row.lease_active) !== 1
    ) {
      throw new WorkflowLeaseLostError();
    }
  }

  private async findCommit(
    manager: EntityManager,
    jobId: string,
  ): Promise<DomainCommitRow | null> {
    const rows: unknown = await manager.query(
      `SELECT resource_id, version_id, commit_payload
         FROM workflow_domain_commits
        WHERE workflow_job_id = ?`,
      [jobId],
    );
    return Array.isArray(rows) && rows.length === 1
      ? (rows[0] as DomainCommitRow)
      : null;
  }

  private async domainCommitResult(
    manager: EntityManager,
    row: DomainCommitRow,
  ): Promise<WorkflowDomainCommitResult> {
    const payload = parseCommitPayload(row.commit_payload);
    if (payload) return payload;
    const citations: unknown = await manager.query(
      `SELECT id, project_id, result_id, paragraph_key, chunk_id, file_id,
              use_type, evidence_text, page_number, section_title,
              confidence_score, created_at
         FROM citation_maps
        WHERE result_id = ?
        ORDER BY created_at, id`,
      [row.resource_id],
    );
    return {
      resourceId: row.resource_id,
      ...(row.version_id ? { versionId: row.version_id } : {}),
      ...(Array.isArray(citations) && citations.length > 0
        ? { citations: citations as Array<Record<string, unknown>> }
        : {}),
    };
  }

  private async nextVersion(
    manager: EntityManager,
    table: 'directory_versions' | 'outline_versions',
    where: string,
    parameters: unknown[],
  ): Promise<number> {
    const rows: unknown = await manager.query(
      `SELECT COALESCE(MAX(version_number), 0) AS maxVersion
         FROM ${table}
        WHERE ${where}`,
      parameters,
    );
    return (
      Number(
        Array.isArray(rows) && rows.length === 1
          ? ((rows[0] as Record<string, unknown>).maxVersion ?? 0)
          : 0,
      ) + 1
    );
  }

  private async findChapterIndex(
    manager: EntityManager,
    projectId: string,
    chapterNodeId: string,
  ): Promise<number> {
    const rows: unknown = await manager.query(
      `SELECT content
         FROM directory_versions
        WHERE project_id = ?
          AND is_current = 1`,
      [projectId],
    );
    if (!Array.isArray(rows) || rows.length !== 1) return 0;
    const raw = (rows[0] as Record<string, unknown>).content;
    const nodes = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    if (!Array.isArray(nodes)) return 0;
    const chapters = nodes.filter(
      (node): node is Record<string, unknown> =>
        typeof node === 'object' &&
        node !== null &&
        (node as Record<string, unknown>).parent_node_id === null,
    );
    return Math.max(
      0,
      chapters.findIndex((node) => node.node_id === chapterNodeId),
    );
  }
}

function affectedRows(result: unknown): number {
  return typeof result === 'object' &&
    result !== null &&
    'affectedRows' in result
    ? Number((result as { affectedRows: unknown }).affectedRows)
    : 0;
}

function requireInput(job: ClaimedWorkflowJob): Record<string, unknown> {
  if (!job.input) throw new BadRequestException('工作流缺少输入');
  return job.input;
}

function requireString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || item.trim() === '') {
    throw new BadRequestException(`工作流字段 ${key} 不能为空`);
  }
  return item;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const item = value[key];
  return typeof item === 'string' && item.trim() !== '' ? item : null;
}

function optionalRowString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseCommitPayload(
  raw: Record<string, unknown> | string | null,
): WorkflowDomainCommitResult | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.resourceId !== 'string' ||
    payload.resourceId.length === 0
  ) {
    return null;
  }
  return {
    resourceId: payload.resourceId,
    ...(typeof payload.versionId === 'string'
      ? { versionId: payload.versionId }
      : {}),
    ...(Array.isArray(payload.citations)
      ? { citations: payload.citations as Array<Record<string, unknown>> }
      : {}),
  };
}

function parseGeneratedObject(
  raw: string,
  errorMessage: string,
): Record<string, unknown> {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  try {
    const parsed: unknown = JSON.parse(
      start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned,
    );
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Project a stable validation error below.
  }
  throw new BadRequestException(errorMessage);
}

function toTaskType(type: WorkflowType): TaskType {
  switch (type) {
    case WorkflowType.REWRITE:
      return TaskType.REWRITE;
    case WorkflowType.EXPAND:
      return TaskType.EXPAND;
    case WorkflowType.COMPRESS:
      return TaskType.COMPRESS;
    default:
      return TaskType.GENERATE;
  }
}

function parseCitationMarkers(content: string): Array<{
  paragraphKey: string;
  chunkId: string;
  useType: CitationUseType;
  description: string;
}> {
  const result: Array<{
    paragraphKey: string;
    chunkId: string;
    useType: CitationUseType;
    description: string;
  }> = [];
  const seen = new Set<string>();
  const blocks = content.matchAll(
    /<!--\s*paragraph_key:\s*(p\d+)\s*-->([\s\S]*?)(?=<!--\s*paragraph_key:\s*p\d+\s*-->|$)/g,
  );
  for (const block of blocks) {
    const citations = (block[2] ?? '').match(
      /<!--\s*citations:\s*p\d+\s*-->([\s\S]*)$/i,
    );
    if (!citations) continue;
    for (const line of citations[1].split('\n')) {
      const match = line
        .trim()
        .replace(/^-+\s*/, '')
        .match(/^\[([^\]]+)\]\(use_type:\s*([^)]+)\)\s*(.*)$/i);
      if (!match) continue;
      const useType = Object.values(CitationUseType).includes(
        match[2].trim() as CitationUseType,
      )
        ? (match[2].trim() as CitationUseType)
        : CitationUseType.SYNTHESIZE;
      const key = `${block[1]}:${match[1].trim()}:${useType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        paragraphKey: block[1],
        chunkId: match[1].trim(),
        useType,
        description: match[3].trim(),
      });
    }
  }
  return result;
}
