import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Buffer } from 'node:buffer';
import { ContentService } from '../../content/content.service.js';
import type { GenerateDirectoryDto } from '../../content/dto/generate-directory.dto.js';
import type { GenerateOutlineDto } from '../../content/dto/generate-outline.dto.js';
import {
  DirectoryNodeType,
  type DirectoryNodeDto,
} from '../../content/dto/save-directory.dto.js';
import { type AtomicGroundingOutcome } from '../../citation/atomic-grounding/atomic-grounding-coordinator.service.js';
import type { SealedGroundedCandidateV1 } from '../../citation/atomic-grounding/contracts.js';
import { MaterialGapError } from '../../citation/material-gap.error.js';
import type {
  ClaimedWorkflowJob,
  WorkflowExecutionEvent,
  WorkflowExecutionOutcome,
  WorkflowTaskContext,
} from '../../workflow/workflow.engine.js';
import { WorkflowType } from '../../workflow/workflow.types.js';
import { StorageReadinessService } from '../../storage/storage-readiness.service.js';
import { AuthoringCommitService } from '../commit/authoring-commit.service.js';
import type {
  AuthoringArtifactKind,
  AuthoringProposal,
} from '../proposal/authoring-proposal.entity.js';
import { AuthoringProposalService } from '../proposal/authoring-proposal.service.js';

export const DETERMINISTIC_AUTHORING_NODES = [
  'permission_input_snapshot',
  'retrieval_plan',
  'hybrid_retrieval',
  'evidence_gate',
  'structured_draft',
  'schema_domain_validation',
  'citation_review',
  'style_consistency_review',
  'targeted_revision',
  'seal_proposal',
] as const;

export type DeterministicAuthoringNode =
  (typeof DETERMINISTIC_AUTHORING_NODES)[number];

export type DeterministicAuthoringTransition =
  | 'permission_input_snapshot->retrieval_plan'
  | 'retrieval_plan->hybrid_retrieval'
  | 'hybrid_retrieval->evidence_gate'
  | 'evidence_gate->structured_draft'
  | 'structured_draft->schema_domain_validation'
  | 'schema_domain_validation->citation_review'
  | 'citation_review->style_consistency_review'
  | 'style_consistency_review->targeted_revision'
  | 'targeted_revision->seal_proposal';

const AUTHORING_GRAPH_VERSION = 'deterministic-authoring-graph.v1';
const DIRECTORY_SCHEMA_VERSION = 'authoring-directory.v1';
const OUTLINE_SCHEMA_VERSION = 'authoring-outline.v1';
const BODY_SCHEMA_VERSION = 'authoring-body.v1';
const MAX_MODEL_CALLS = 9;
const MAX_REVISIONS = 2;
const MAX_OUTPUT_TOKENS = 64 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

type DeterministicDefinition =
  | 'deterministic-authoring-shadow.v1'
  | 'deterministic-authoring.v1';

interface DeterministicCheckpoint extends Record<string, unknown> {
  graph_version: typeof AUTHORING_GRAPH_VERSION;
  phase:
    | 'executing'
    | 'proposal_sealed'
    | 'waiting_approval'
    | 'shadow_completed'
    | 'committed';
  completed_nodes: DeterministicAuthoringNode[];
  model_calls: number;
  revision_attempts: number;
  artifact_kind?: AuthoringArtifactKind;
  schema_version?: string;
  payload_base64?: string;
  sealed_candidate?: SealedGroundedCandidateV1;
  proposal_id?: string;
  proposal_digest?: string;
  resource_id?: string;
  version_id?: string;
}

interface DraftArtifact {
  artifactKind: AuthoringArtifactKind;
  schemaVersion: string;
  payload: Buffer;
  atomicOutcome?: AtomicGroundingOutcome;
}

export class AuthoringGraphLimitError extends Error {
  constructor(
    readonly code:
      | 'AUTHORING_MODEL_CALL_LIMIT'
      | 'AUTHORING_OUTPUT_BYTE_LIMIT'
      | 'AUTHORING_OUTPUT_TOKEN_LIMIT'
      | 'AUTHORING_REVISION_LIMIT',
  ) {
    super(code);
    this.name = 'AuthoringGraphLimitError';
  }
}

export class AuthoringModelCallBudget {
  private calls = 0;

  constructor(
    private readonly maximum = MAX_MODEL_CALLS,
    initialCalls = 0,
  ) {
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      !Number.isSafeInteger(initialCalls) ||
      initialCalls < 0 ||
      initialCalls > maximum
    ) {
      throw new AuthoringGraphLimitError('AUTHORING_MODEL_CALL_LIMIT');
    }
    this.calls = initialCalls;
  }

  get used(): number {
    return this.calls;
  }

  async run<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    if (this.calls >= this.maximum) {
      throw new AuthoringGraphLimitError('AUTHORING_MODEL_CALL_LIMIT');
    }
    this.calls += 1;
    const result = await operation(signal);
    throwIfAborted(signal);
    return result;
  }
}

@Injectable()
export class DeterministicAuthoringGraph {
  constructor(
    private readonly contentService: ContentService,
    private readonly proposalService: AuthoringProposalService,
    private readonly commitService: AuthoringCommitService,
    @Optional() private readonly storageReadiness?: StorageReadinessService,
  ) {}

  async *execute(
    job: ClaimedWorkflowJob,
    context: WorkflowTaskContext,
  ): AsyncGenerator<WorkflowExecutionEvent, WorkflowExecutionOutcome, void> {
    const definition = requireDefinition(job.workflowDefinition);
    const enforce = definition === 'deterministic-authoring.v1';
    const restored = readCheckpoint(job.checkpoint);
    throwIfAborted(context.signal);
    if (enforce) {
      if (!this.storageReadiness) {
        throw new Error('STORAGE_AUTHORITY_UNPROVEN');
      }
      await this.storageReadiness.assertReady();
      throwIfAborted(context.signal);
    }

    if (enforce) {
      const active = await this.findActiveProposal(job);
      if (active) {
        if (active.status === 'APPROVED') {
          return yield* this.commitApproved(job, context, active, restored);
        }
        yield graphEvent(
          'authoring.proposal_recovered',
          {
            proposal_id: active.id,
            proposal_digest: active.payload_sha256,
            status: active.status,
          },
          proposalCheckpoint(active, restored),
        );
        return { kind: 'SUSPENDED', reason: 'WAITING_APPROVAL' };
      }
      if (restored?.proposal_id) {
        return yield* this.commitApproved(
          job,
          context,
          {
            id: restored.proposal_id,
            payload_sha256: restored.proposal_digest ?? '',
          },
          restored,
        );
      }
    } else if (restored?.phase === 'shadow_completed') {
      return { kind: 'SUSPENDED', reason: 'SHADOW_COMPLETED' };
    }

    const budget = new AuthoringModelCallBudget(
      MAX_MODEL_CALLS,
      restored?.model_calls ?? 0,
    );
    let revisionAttempts = restored?.revision_attempts ?? 0;
    let completedNodes = restored?.completed_nodes ?? [];
    let artifact = restoreArtifact(restored);
    if (!artifact && completedNodes.includes('structured_draft')) {
      completedNodes = completedNodes.filter(
        (node) =>
          DETERMINISTIC_AUTHORING_NODES.indexOf(node) <
          DETERMINISTIC_AUTHORING_NODES.indexOf('structured_draft'),
      );
    }

    for (const node of DETERMINISTIC_AUTHORING_NODES) {
      throwIfAborted(context.signal);
      if (completedNodes.includes(node)) continue;

      switch (node) {
        case 'permission_input_snapshot':
          await this.contentService.assertProjectOwner(
            job.userId,
            job.projectId,
          );
          requireInput(job);
          break;
        case 'retrieval_plan':
        case 'hybrid_retrieval':
        case 'evidence_gate':
          // The existing content/atomic-grounding preparation owns retrieval,
          // evidence snapshots and the strict gate. These nodes deliberately
          // select that fixed path; they never accept model-selected tools.
          break;
        case 'structured_draft':
          artifact = await this.generateDraft(job, context.signal, budget);
          break;
        case 'schema_domain_validation':
          artifact = validateArtifact(job, requireArtifact(artifact));
          break;
        case 'citation_review':
          assertCitationReview(job, requireArtifact(artifact));
          break;
        case 'style_consistency_review':
          assertStyleConsistency(requireArtifact(artifact));
          break;
        case 'targeted_revision': {
          const revision = await this.reviseIfRequired(
            job,
            context.signal,
            budget,
            requireArtifact(artifact),
            revisionAttempts,
          );
          artifact = revision.artifact;
          revisionAttempts = revision.revisionAttempts;
          break;
        }
        case 'seal_proposal':
          break;
      }

      completedNodes = [...completedNodes, node];
      const checkpoint = executionCheckpoint({
        completedNodes,
        budget,
        revisionAttempts,
        artifact,
      });
      yield graphEvent(
        'authoring.node_completed',
        {
          node,
          node_index: DETERMINISTIC_AUTHORING_NODES.indexOf(node),
          model_calls: budget.used,
          revision_attempts: revisionAttempts,
        },
        checkpoint,
      );
    }

    artifact = validateArtifact(job, requireArtifact(artifact));
    if (!enforce) {
      yield graphEvent(
        'authoring.shadow_completed',
        {
          workflow_definition: definition,
          artifact_kind: artifact.artifactKind,
          payload_utf8_bytes: artifact.payload.byteLength,
        },
        {
          ...executionCheckpoint({
            completedNodes,
            budget,
            revisionAttempts,
            artifact,
          }),
          phase: 'shadow_completed',
        },
      );
      return { kind: 'SUSPENDED', reason: 'SHADOW_COMPLETED' };
    }

    const proposal = await this.proposalService.store(job, {
      artifactKind: artifact.artifactKind,
      schemaVersion: artifact.schemaVersion,
      payload: Buffer.from(artifact.payload),
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    });
    yield graphEvent(
      'authoring.proposal_sealed',
      {
        proposal_id: proposal.id,
        proposal_digest: proposal.payload_sha256,
        artifact_kind: proposal.artifact_kind,
        payload_utf8_bytes: proposal.payload_utf8_bytes,
      },
      {
        ...proposalCheckpoint(proposal, {
          ...executionCheckpoint({
            completedNodes,
            budget,
            revisionAttempts,
            artifact,
          }),
          phase: 'proposal_sealed',
        }),
        phase: 'waiting_approval',
      },
    );
    return { kind: 'SUSPENDED', reason: 'WAITING_APPROVAL' };
  }

  private async *commitApproved(
    job: ClaimedWorkflowJob,
    context: WorkflowTaskContext,
    proposal: Pick<AuthoringProposal, 'id' | 'payload_sha256'>,
    restored: DeterministicCheckpoint | null,
  ): AsyncGenerator<WorkflowExecutionEvent, WorkflowExecutionOutcome, void> {
    throwIfAborted(context.signal);
    let commitJob = job;
    if (isBodyWorkflow(job.workflowType)) {
      if (!restored?.sealed_candidate) {
        throw new MaterialGapError('批准的正文提案缺少可信引用封存结果');
      }
      const recovered =
        await this.contentService.recoverAtomicGroundingCandidate(
          job.id,
          job.projectId,
          restored.sealed_candidate,
        );
      throwIfAborted(context.signal);
      if (recovered.kind === 'material_gap') throw materialGap(recovered);
      if (recovered.kind !== 'sealed') {
        throw new MaterialGapError(
          '批准后可信引用状态已变化',
          recovered.unsupported_claims.map(
            (claim) => claim.candidate_claim_key,
          ),
        );
      }
      assertSealedCandidate(job, recovered.candidate);
      commitJob = {
        ...job,
        checkpoint: {
          ...(job.checkpoint ?? {}),
          sealed_candidate: recovered.candidate,
        },
      };
    }
    const receipt = await this.commitService.commitApproved(commitJob);
    throwIfAborted(context.signal);
    const checkpoint: DeterministicCheckpoint = {
      ...proposalCheckpoint(proposal, restored),
      phase: 'committed',
      resource_id: receipt.resourceId,
      version_id: receipt.versionId,
    };
    yield graphEvent(
      'authoring.committed',
      {
        proposal_id: proposal.id,
        resource_id: receipt.resourceId,
        version_id: receipt.versionId,
      },
      checkpoint,
    );
    yield graphEvent(
      'done',
      {
        type: 'done',
        result_id: receipt.resourceId,
        version_id: receipt.versionId,
        status: 'succeeded',
        server_saved: true,
        workflow_job_id: job.id,
      },
      checkpoint,
    );
    return { kind: 'COMPLETED' };
  }

  private async findActiveProposal(
    job: ClaimedWorkflowJob,
  ): Promise<AuthoringProposal | null> {
    try {
      return await this.proposalService.findActive(
        job.userId,
        job.projectId,
        job.id,
      );
    } catch (error: unknown) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  private async generateDraft(
    job: ClaimedWorkflowJob,
    signal: AbortSignal,
    budget: AuthoringModelCallBudget,
  ): Promise<DraftArtifact> {
    const input = requireInput(job);
    switch (job.workflowType) {
      case WorkflowType.DIRECTORY: {
        const output = await budget.run(signal, async (callSignal) =>
          collectModelOutput(
            this.contentService.generateDirectory(
              job.userId,
              job.projectId,
              input as unknown as GenerateDirectoryDto,
              callSignal,
              trace(job, 'structured_directory_draft', budget.used),
            ),
            callSignal,
          ),
        );
        return {
          artifactKind: 'directory',
          schemaVersion: DIRECTORY_SCHEMA_VERSION,
          payload: Buffer.from(
            JSON.stringify(parseDirectoryPayload(output)),
            'utf8',
          ),
        };
      }
      case WorkflowType.OUTLINE: {
        const output = await budget.run(signal, async (callSignal) =>
          collectModelOutput(
            this.contentService.generateOutline(
              job.userId,
              job.projectId,
              input as unknown as GenerateOutlineDto,
              callSignal,
              trace(job, 'structured_outline_draft', budget.used),
            ),
            callSignal,
          ),
        );
        return {
          artifactKind: 'outline',
          schemaVersion: OUTLINE_SCHEMA_VERSION,
          payload: Buffer.from(
            JSON.stringify(parseOutlinePayload(output)),
            'utf8',
          ),
        };
      }
      case WorkflowType.CONTENT:
      case WorkflowType.REWRITE:
      case WorkflowType.EXPAND:
      case WorkflowType.COMPRESS: {
        const outcome = await budget.run(signal, (callSignal) =>
          this.contentService.generateAtomicGroundingCandidate(
            job.workflowType as 'content' | 'rewrite' | 'expand' | 'compress',
            job.userId,
            job.projectId,
            input,
            callSignal,
            trace(job, 'structured_grounded_draft', budget.used),
          ),
        );
        if (outcome.kind === 'material_gap') throw materialGap(outcome);
        const text =
          outcome.kind === 'sealed' ? outcome.candidate.server_output.text : '';
        assertOutputLimits(text);
        return {
          artifactKind: 'body',
          schemaVersion: BODY_SCHEMA_VERSION,
          payload: Buffer.from(text, 'utf8'),
          atomicOutcome: outcome,
        };
      }
      default:
        throw new BadRequestException(
          `确定性写作图不支持 ${job.workflowType} 工作流`,
        );
    }
  }

  private async reviseIfRequired(
    job: ClaimedWorkflowJob,
    signal: AbortSignal,
    budget: AuthoringModelCallBudget,
    artifact: DraftArtifact,
    previousAttempts: number,
  ): Promise<{ artifact: DraftArtifact; revisionAttempts: number }> {
    let outcome = artifact.atomicOutcome;
    if (!outcome || outcome.kind === 'sealed') {
      return { artifact, revisionAttempts: previousAttempts };
    }
    if (outcome.kind === 'material_gap') throw materialGap(outcome);
    if (previousAttempts >= MAX_REVISIONS) {
      throw new AuthoringGraphLimitError('AUTHORING_REVISION_LIMIT');
    }

    const revisionAttempts = previousAttempts + 1;
    const claims = outcome.unsupported_claims.map((claim) => ({
      claim_id: claim.candidate_claim_key,
      claim_text: claim.source_claim_text_nfc,
    }));
    await this.contentService.prepareGroundingRevision(
      job.userId,
      job.projectId,
      job.id,
      claims,
      signal,
      outcome.base_retrieval_run_id,
    );
    throwIfAborted(signal);

    const revisionInput = {
      ...requireInput(job),
      revision_attempt: 1,
      revision: {
        base_proposal: outcome.canonical_proposal,
        allowed_candidate_claim_keys: outcome.unsupported_claims.map(
          (claim) => claim.candidate_claim_key,
        ),
        non_target_invariant_digests: outcome.non_target_invariant_digests,
      },
    };
    outcome = await budget.run(signal, (callSignal) =>
      this.contentService.generateAtomicGroundingRevisionCandidate(
        job.workflowType as 'content' | 'rewrite' | 'expand' | 'compress',
        job.userId,
        job.projectId,
        revisionInput,
        callSignal,
        trace(job, 'targeted_grounding_revision', revisionAttempts),
      ),
    );
    if (outcome.kind === 'material_gap') throw materialGap(outcome);
    if (outcome.kind === 'revision_required') {
      // atomic:v1 permits one targeted model revision. Staying inside that
      // stricter verifier contract is preferable to a second unverified edit.
      throw new MaterialGapError(
        '定向修订后仍有声明缺少可信证据',
        outcome.unsupported_claims.map((claim) => claim.candidate_claim_key),
      );
    }
    assertSealedCandidate(job, outcome.candidate);
    return {
      artifact: {
        artifactKind: 'body',
        schemaVersion: BODY_SCHEMA_VERSION,
        payload: Buffer.from(outcome.candidate.server_output.text, 'utf8'),
        atomicOutcome: outcome,
      },
      revisionAttempts,
    };
  }
}

export function isDeterministicAuthoringDefinition(
  value: unknown,
): value is DeterministicDefinition {
  return (
    value === 'deterministic-authoring-shadow.v1' ||
    value === 'deterministic-authoring.v1'
  );
}

function requireDefinition(value: unknown): DeterministicDefinition {
  if (!isDeterministicAuthoringDefinition(value)) {
    throw new BadRequestException('确定性写作图定义无效');
  }
  return value;
}

function requireInput(job: ClaimedWorkflowJob): Record<string, unknown> {
  if (
    typeof job.input !== 'object' ||
    job.input === null ||
    Array.isArray(job.input)
  ) {
    throw new BadRequestException('工作流缺少输入');
  }
  return job.input;
}

function trace(
  job: ClaimedWorkflowJob,
  node: string,
  attempt: number,
): {
  workflow_job_id: string;
  node: string;
  attempt: number;
} {
  return {
    workflow_job_id: job.id,
    node,
    attempt,
  };
}

async function collectModelOutput(
  stream: AsyncIterable<string>,
  signal: AbortSignal,
): Promise<string> {
  let output = '';
  for await (const token of stream) {
    throwIfAborted(signal);
    output += token;
    assertOutputLimits(output);
  }
  throwIfAborted(signal);
  assertOutputLimits(output);
  return output;
}

function assertOutputLimits(output: string): void {
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new AuthoringGraphLimitError('AUTHORING_OUTPUT_BYTE_LIMIT');
  }
  // UTF-8 bytes are a provider-independent conservative ceiling: a tokenizer
  // cannot produce more tokens than there are encoded input bytes.
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_TOKENS) {
    throw new AuthoringGraphLimitError('AUTHORING_OUTPUT_TOKEN_LIMIT');
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
}

function materialGap(
  outcome: Extract<AtomicGroundingOutcome, { kind: 'material_gap' }>,
): MaterialGapError {
  return new MaterialGapError(
    `素材不足：${outcome.reason_code}`,
    outcome.candidate_claim_keys,
  );
}

function requireArtifact(artifact: DraftArtifact | null): DraftArtifact {
  if (!artifact) throw new Error('AUTHORING_DRAFT_MISSING');
  return artifact;
}

function validateArtifact(
  job: ClaimedWorkflowJob,
  artifact: DraftArtifact,
): DraftArtifact {
  assertOutputLimits(artifact.payload.toString('utf8'));
  switch (artifact.artifactKind) {
    case 'directory':
      parseDirectoryPayload(artifact.payload.toString('utf8'));
      break;
    case 'outline':
      parseOutlinePayload(artifact.payload.toString('utf8'));
      break;
    case 'body':
      if (artifact.atomicOutcome?.kind === 'revision_required') break;
      if (artifact.payload.byteLength === 0) {
        throw new BadRequestException('正文不能为空');
      }
      if (!artifact.atomicOutcome || artifact.atomicOutcome.kind !== 'sealed') {
        throw new MaterialGapError('正文尚未通过可信引用审查');
      }
      assertSealedCandidate(job, artifact.atomicOutcome.candidate);
      break;
  }
  return artifact;
}

function assertCitationReview(
  job: ClaimedWorkflowJob,
  artifact: DraftArtifact,
): void {
  if (artifact.artifactKind !== 'body') return;
  if (!artifact.atomicOutcome || artifact.atomicOutcome.kind !== 'sealed') {
    // A revision_required result is intentionally allowed to reach the fixed
    // targeted revision node, but it can never be sealed as a proposal.
    if (artifact.atomicOutcome?.kind === 'revision_required') return;
    throw new MaterialGapError('正文缺少可信引用结果');
  }
  assertSealedCandidate(job, artifact.atomicOutcome.candidate);
}

function assertStyleConsistency(artifact: DraftArtifact): void {
  if (artifact.atomicOutcome?.kind === 'revision_required') return;
  const value = artifact.payload.toString('utf8').trim();
  if (artifact.artifactKind === 'body' && value.length === 0) {
    throw new BadRequestException('正文风格审查失败：内容为空');
  }
}

function assertSealedCandidate(
  job: ClaimedWorkflowJob,
  candidate: SealedGroundedCandidateV1,
): void {
  const text = candidate.server_output.text;
  if (
    candidate.contract_version !== 'atomic:v1' ||
    candidate.workflow.workflow_job_id !== job.id ||
    candidate.workflow.project_id !== job.projectId ||
    candidate.workflow.workflow_type !== String(job.workflowType) ||
    candidate.server_output.utf8_byte_length !==
      Buffer.byteLength(text, 'utf8') ||
    candidate.server_output.utf16_length !== text.length ||
    candidate.claims.some((claim) => claim.support_status !== 'SUPPORTED')
  ) {
    throw new MaterialGapError('正文未通过 atomic grounding 封存校验');
  }
  assertOutputLimits(text);
}

function parseDirectoryPayload(raw: string): DirectoryNodeDto[] {
  const parsed = parseJson(raw);
  if (Array.isArray(parsed)) {
    return validateFlatDirectory(parsed);
  }
  const roots = asRecord(parsed).nodes;
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new BadRequestException('目录格式错误：缺少 nodes 字段');
  }
  const flattened: DirectoryNodeDto[] = [];
  const ids = new Set<string>();
  const visit = (nodes: unknown[], parentId: string | null): void => {
    nodes.forEach((rawNode, index) => {
      const node = asRecord(rawNode);
      const id = requireString(node, 'key');
      const title = requireString(node, 'title');
      if (ids.has(id)) {
        throw new BadRequestException(`目录节点标识重复: ${id}`);
      }
      ids.add(id);
      const children =
        node.children === undefined
          ? []
          : Array.isArray(node.children)
            ? node.children
            : invalidChildren(id);
      flattened.push({
        node_id: id,
        parent_node_id: parentId,
        node_type:
          parentId === null || children.length > 0
            ? DirectoryNodeType.CHAPTER
            : DirectoryNodeType.SECTION,
        order_index: index,
        title,
        ...(typeof node.description === 'string'
          ? { description: node.description }
          : {}),
        ...(typeof node.material_support === 'string'
          ? { material_support: node.material_support }
          : {}),
        ...(typeof node.level === 'string' ? { level_label: node.level } : {}),
      });
      visit(children, id);
    });
  };
  visit(roots, null);
  return flattened;
}

function validateFlatDirectory(value: unknown[]): DirectoryNodeDto[] {
  if (value.length === 0) {
    throw new BadRequestException('目录节点不能为空');
  }
  const ids = new Set<string>();
  const nodes = value.map((item) => {
    const node = asRecord(item);
    const nodeId = requireString(node, 'node_id');
    if (ids.has(nodeId)) {
      throw new BadRequestException(`目录节点标识重复: ${nodeId}`);
    }
    ids.add(nodeId);
    const parent =
      node.parent_node_id === null
        ? null
        : requireString(node, 'parent_node_id');
    const nodeType = node.node_type;
    if (
      nodeType !== DirectoryNodeType.CHAPTER &&
      nodeType !== DirectoryNodeType.SECTION
    ) {
      throw new BadRequestException('目录节点类型无效');
    }
    if (
      !Number.isSafeInteger(node.order_index) ||
      Number(node.order_index) < 0
    ) {
      throw new BadRequestException('目录节点顺序无效');
    }
    return {
      node_id: nodeId,
      parent_node_id: parent,
      node_type: nodeType,
      order_index: Number(node.order_index),
      title: requireString(node, 'title'),
      ...(typeof node.description === 'string'
        ? { description: node.description }
        : {}),
      ...(typeof node.material_support === 'string'
        ? { material_support: node.material_support }
        : {}),
      ...(typeof node.level_label === 'string'
        ? { level_label: node.level_label }
        : {}),
    };
  });
  if (
    nodes.some(
      (node) => node.parent_node_id !== null && !ids.has(node.parent_node_id),
    )
  ) {
    throw new BadRequestException('目录节点父级不存在');
  }
  return nodes;
}

function parseOutlinePayload(raw: string): Record<string, unknown> {
  const value = parseJson(raw);
  const outline = asRecord(value);
  if (Object.keys(outline).length === 0) {
    throw new BadRequestException('大纲内容不能为空');
  }
  return outline;
}

function parseJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/iu, '')
    .replace(/^```\s*/u, '')
    .replace(/\s*```$/u, '');
  const objectStart = cleaned.indexOf('{');
  const arrayStart = cleaned.indexOf('[');
  const start =
    objectStart < 0
      ? arrayStart
      : arrayStart < 0
        ? objectStart
        : Math.min(objectStart, arrayStart);
  const objectEnd = cleaned.lastIndexOf('}');
  const arrayEnd = cleaned.lastIndexOf(']');
  const end = Math.max(objectEnd, arrayEnd);
  const json =
    start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new BadRequestException('结构化内容解析失败');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException('结构化内容必须是普通对象');
  }
  return value as Record<string, unknown>;
}

function requireString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || item.trim() === '') {
    throw new BadRequestException(`工作流字段 ${key} 不能为空`);
  }
  return item;
}

function invalidChildren(id: string): never {
  throw new BadRequestException(`目录节点 children 必须是数组: ${id}`);
}

function executionCheckpoint(input: {
  completedNodes: DeterministicAuthoringNode[];
  budget: AuthoringModelCallBudget;
  revisionAttempts: number;
  artifact: DraftArtifact | null;
}): DeterministicCheckpoint {
  return {
    graph_version: AUTHORING_GRAPH_VERSION,
    phase: 'executing',
    completed_nodes: [...input.completedNodes],
    model_calls: input.budget.used,
    revision_attempts: input.revisionAttempts,
    ...(input.artifact
      ? {
          artifact_kind: input.artifact.artifactKind,
          schema_version: input.artifact.schemaVersion,
          payload_base64: input.artifact.payload.toString('base64'),
          ...(input.artifact.atomicOutcome?.kind === 'sealed'
            ? { sealed_candidate: input.artifact.atomicOutcome.candidate }
            : {}),
        }
      : {}),
  };
}

function proposalCheckpoint(
  proposal: Pick<AuthoringProposal, 'id' | 'payload_sha256'> &
    Partial<Pick<AuthoringProposal, 'artifact_kind' | 'schema_version'>>,
  restored: DeterministicCheckpoint | null,
): DeterministicCheckpoint {
  return {
    graph_version: AUTHORING_GRAPH_VERSION,
    phase: 'waiting_approval',
    completed_nodes: restored?.completed_nodes ?? [
      ...DETERMINISTIC_AUTHORING_NODES,
    ],
    model_calls: restored?.model_calls ?? 0,
    revision_attempts: restored?.revision_attempts ?? 0,
    ...(proposal.artifact_kind
      ? { artifact_kind: proposal.artifact_kind }
      : restored?.artifact_kind
        ? { artifact_kind: restored.artifact_kind }
        : {}),
    ...(proposal.schema_version
      ? { schema_version: proposal.schema_version }
      : restored?.schema_version
        ? { schema_version: restored.schema_version }
        : {}),
    ...(restored?.sealed_candidate
      ? { sealed_candidate: restored.sealed_candidate }
      : {}),
    proposal_id: proposal.id,
    proposal_digest: proposal.payload_sha256,
  };
}

function readCheckpoint(
  raw: Record<string, unknown> | null,
): DeterministicCheckpoint | null {
  if (!raw || raw.graph_version !== AUTHORING_GRAPH_VERSION) return null;
  const completedNodes = Array.isArray(raw.completed_nodes)
    ? raw.completed_nodes.filter(isAuthoringNode)
    : [];
  const modelCalls = nonNegativeInteger(raw.model_calls);
  const revisionAttempts = nonNegativeInteger(raw.revision_attempts);
  if (modelCalls > MAX_MODEL_CALLS || revisionAttempts > MAX_REVISIONS) {
    throw new Error('AUTHORING_CHECKPOINT_INVALID');
  }
  const phase = raw.phase;
  if (
    phase !== 'executing' &&
    phase !== 'proposal_sealed' &&
    phase !== 'waiting_approval' &&
    phase !== 'shadow_completed' &&
    phase !== 'committed'
  ) {
    throw new Error('AUTHORING_CHECKPOINT_INVALID');
  }
  return {
    graph_version: AUTHORING_GRAPH_VERSION,
    phase,
    completed_nodes: completedNodes,
    model_calls: modelCalls,
    revision_attempts: revisionAttempts,
    ...(isArtifactKind(raw.artifact_kind)
      ? { artifact_kind: raw.artifact_kind }
      : {}),
    ...(typeof raw.schema_version === 'string'
      ? { schema_version: raw.schema_version }
      : {}),
    ...(typeof raw.payload_base64 === 'string'
      ? { payload_base64: raw.payload_base64 }
      : {}),
    ...(isPlainRecord(raw.sealed_candidate)
      ? {
          sealed_candidate:
            raw.sealed_candidate as unknown as SealedGroundedCandidateV1,
        }
      : {}),
    ...(typeof raw.proposal_id === 'string'
      ? { proposal_id: raw.proposal_id }
      : {}),
    ...(typeof raw.proposal_digest === 'string'
      ? { proposal_digest: raw.proposal_digest }
      : {}),
    ...(typeof raw.resource_id === 'string'
      ? { resource_id: raw.resource_id }
      : {}),
    ...(typeof raw.version_id === 'string'
      ? { version_id: raw.version_id }
      : {}),
  };
}

function restoreArtifact(
  checkpoint: DeterministicCheckpoint | null,
): DraftArtifact | null {
  if (
    !checkpoint?.artifact_kind ||
    !checkpoint.schema_version ||
    !checkpoint.payload_base64
  ) {
    return null;
  }
  const payload = Buffer.from(checkpoint.payload_base64, 'base64');
  if (
    payload.byteLength === 0 ||
    payload.toString('base64') !== checkpoint.payload_base64
  ) {
    throw new Error('AUTHORING_CHECKPOINT_INVALID');
  }
  if (checkpoint.artifact_kind === 'body') {
    if (!checkpoint.sealed_candidate) return null;
    return {
      artifactKind: 'body',
      schemaVersion: checkpoint.schema_version,
      payload,
      atomicOutcome: {
        kind: 'sealed',
        candidate: checkpoint.sealed_candidate,
      },
    };
  }
  return {
    artifactKind: checkpoint.artifact_kind,
    schemaVersion: checkpoint.schema_version,
    payload,
  };
}

function isAuthoringNode(value: unknown): value is DeterministicAuthoringNode {
  return DETERMINISTIC_AUTHORING_NODES.includes(
    value as DeterministicAuthoringNode,
  );
}

function isArtifactKind(value: unknown): value is AuthoringArtifactKind {
  return value === 'directory' || value === 'outline' || value === 'body';
}

function isBodyWorkflow(
  value: WorkflowType,
): value is
  | WorkflowType.CONTENT
  | WorkflowType.REWRITE
  | WorkflowType.EXPAND
  | WorkflowType.COMPRESS {
  return (
    value === WorkflowType.CONTENT ||
    value === WorkflowType.REWRITE ||
    value === WorkflowType.EXPAND ||
    value === WorkflowType.COMPRESS
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('AUTHORING_CHECKPOINT_INVALID');
  }
  return parsed;
}

function graphEvent(
  type: string,
  data: Record<string, unknown> | null,
  checkpoint: DeterministicCheckpoint,
): WorkflowExecutionEvent {
  return { type, data, checkpoint };
}
