import { Inject, Injectable } from '@nestjs/common';
import { buildEvidenceContext } from './context-builder.js';
import { reciprocalRankFusion } from './fusion.js';
import { planRetrievalQuery } from './query-planner.js';
import type {
  DenseRetrieverPort,
  FusedCandidate,
  HybridRetrievalRequest,
  HybridRetrievalResult,
  LegacyRetrieverPort,
  RetrievalRunRecorder,
  RetrievalState,
  SparseRetrieverPort,
} from './types.js';
import {
  DENSE_RETRIEVER,
  LEGACY_RETRIEVER,
  RETRIEVAL_RUN_RECORDER,
  SPARSE_RETRIEVER,
} from './injection-tokens.js';
import { NeighborExpander } from './neighbor-expander.js';

@Injectable()
export class HybridRetriever {
  constructor(
    @Inject(SPARSE_RETRIEVER)
    private readonly sparse: SparseRetrieverPort,
    @Inject(DENSE_RETRIEVER)
    private readonly dense: DenseRetrieverPort,
    @Inject(LEGACY_RETRIEVER)
    private readonly legacy: LegacyRetrieverPort,
    @Inject(RETRIEVAL_RUN_RECORDER)
    private readonly recorder: RetrievalRunRecorder,
    private readonly neighborExpander: NeighborExpander,
  ) {}

  async retrieve(
    request: HybridRetrievalRequest,
  ): Promise<HybridRetrievalResult> {
    const startedAt = Date.now();
    const mode = request.mode ?? 'hybrid';
    const gateDecision = request.gate_decision ?? mode === 'hybrid';
    const canonicalPath =
      mode === 'hybrid' && gateDecision ? 'hybrid' : 'legacy_like';
    const shadowPath = canonicalPath === 'hybrid' ? 'legacy_like' : 'hybrid';
    const plan = planRetrievalQuery({
      query: request.query,
      task_type: request.task_type,
    });
    const runStart = {
      project_id: request.project_id,
      query: request.query,
      task_type: request.task_type,
      plan,
      mode,
      gate_decision: gateDecision,
      canonical_path: canonicalPath,
      shadow_path: shadowPath,
      top_k: request.top_k,
      token_budget: request.token_budget,
      ...(request.workflow_job_id
        ? { workflow_job_id: request.workflow_job_id }
        : {}),
      ...(request.revision_attempt
        ? { revision_attempt: request.revision_attempt }
        : {}),
    } as const;
    const scoped =
      request.workflow_job_id !== undefined ||
      request.revision_attempt !== undefined;
    if (
      scoped &&
      (!request.workflow_job_id ||
        request.revision_attempt !== 1 ||
        !this.recorder.startIdempotent)
    ) {
      throw new Error('TARGETED_RETRIEVAL_IDEMPOTENCY_UNAVAILABLE');
    }
    const start = scoped
      ? await this.recorder.startIdempotent!(runStart)
      : {
          kind: 'started' as const,
          run_id: await this.recorder.start(runStart),
        };
    if (start.kind === 'recovered') return start.result;
    const runId = start.run_id;

    const [sparseResult, denseResult, legacyResult] = await Promise.all([
      timedSettle(
        this.sparse.search({
          project_id: request.project_id,
          sparse_query: plan.sparse_query,
          limit: 40,
        }),
      ),
      timedSettle(
        this.dense.search({
          ...plan,
          project_id: request.project_id,
          limit: 40,
        }),
      ),
      timedSettle(
        this.legacy.search({
          project_id: request.project_id,
          terms: plan.terms,
          limit: 40,
        }),
      ),
    ]);

    const sparseCandidates =
      sparseResult.result.ok && sparseResult.result.value
        ? sparseResult.result.value
        : [];
    const denseCandidates =
      denseResult.result.ok && denseResult.result.value
        ? denseResult.result.value.candidates
        : [];
    const denseUnavailable =
      !denseResult.result.ok ||
      denseResult.result.value?.state === 'unavailable';
    const sparseUnavailable = !sparseResult.result.ok;
    const bothUnavailable = sparseUnavailable && denseUnavailable;

    let state: RetrievalState;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    if (bothUnavailable) {
      state = 'ERROR';
      errorCode = 'RETRIEVAL_BACKENDS_UNAVAILABLE';
      errorMessage = [
        failureMessage(sparseResult.result),
        denseResult.result.ok
          ? denseResult.result.value?.error_code
          : failureMessage(denseResult.result),
      ]
        .filter(Boolean)
        .join('; ');
    } else if (sparseUnavailable || denseUnavailable) {
      state = 'DEGRADED';
      errorCode = sparseUnavailable
        ? 'SPARSE_UNAVAILABLE'
        : denseResult.result.ok
          ? (denseResult.result.value?.error_code ?? 'DENSE_UNAVAILABLE')
          : 'DENSE_UNAVAILABLE';
      errorMessage = sparseUnavailable
        ? failureMessage(sparseResult.result)
        : failureMessage(denseResult.result);
    } else if (sparseCandidates.length === 0 && denseCandidates.length === 0) {
      state = 'NO_HIT';
    } else {
      state = 'READY';
    }

    let expanded: FusedCandidate[] = [];
    let context: ReturnType<typeof buildEvidenceContext> = {
      items: [],
      used_tokens: 0,
    };
    if (state !== 'ERROR') {
      try {
        const fused = rerankLocally(
          reciprocalRankFusion(sparseCandidates, denseCandidates),
          plan.terms,
        );
        expanded = await this.neighborExpander.expand(
          request.project_id,
          fused,
        );
        context = buildEvidenceContext(expanded, {
          top_k: request.top_k,
          token_budget: request.token_budget,
          max_per_source: 2,
          query_embedding:
            denseResult.result.ok && denseResult.result.value
              ? (denseResult.result.value.query_embedding ?? null)
              : null,
          query_terms: plan.terms,
          retrieval_run_id: runId,
        });
      } catch (error) {
        state = 'ERROR';
        errorCode = 'RETRIEVAL_PIPELINE_FAILED';
        errorMessage = error instanceof Error ? error.message : String(error);
        expanded = [];
        context = { items: [], used_tokens: 0 };
      }
    }
    const legacyCount =
      legacyResult.result.ok && legacyResult.result.value
        ? legacyResult.result.value.length
        : 0;
    const legacyState: RetrievalState = !legacyResult.result.ok
      ? 'ERROR'
      : legacyCount > 0
        ? 'READY'
        : 'NO_HIT';
    const legacyErrorMessage = failureMessage(legacyResult.result);
    const legacyErrorCode =
      legacyState === 'ERROR' ? 'LEGACY_RETRIEVAL_FAILED' : null;
    const canonicalState = canonicalPath === 'hybrid' ? state : legacyState;
    const canonicalErrorCode =
      canonicalPath === 'hybrid' ? errorCode : legacyErrorCode;
    const canonicalErrorMessage =
      canonicalPath === 'hybrid' ? errorMessage : legacyErrorMessage;
    const canonicalLatency =
      canonicalPath === 'hybrid'
        ? Math.max(sparseResult.latency_ms, denseResult.latency_ms)
        : legacyResult.latency_ms;
    const shadowState = canonicalPath === 'hybrid' ? legacyState : state;
    const shadowErrorCode =
      canonicalPath === 'hybrid' ? legacyErrorCode : errorCode;
    const shadowErrorMessage =
      canonicalPath === 'hybrid' ? legacyErrorMessage : errorMessage;
    const shadowLatency =
      canonicalPath === 'hybrid'
        ? legacyResult.latency_ms
        : Math.max(sparseResult.latency_ms, denseResult.latency_ms);
    const denseMetadata =
      denseResult.result.ok && denseResult.result.value
        ? denseResult.result.value
        : null;

    await this.recorder.complete(runId, {
      state: canonicalState,
      error_code: canonicalErrorCode,
      error_message: canonicalErrorMessage,
      latency_ms: Date.now() - startedAt,
      sparse_count: sparseCandidates.length,
      dense_count: denseCandidates.length,
      fused_count: expanded.length,
      legacy_count: legacyCount,
      selected_count: context.items.length,
      embedding_cost_usd: denseMetadata?.embedding_usage?.cost_usd ?? null,
      embedding_input_tokens:
        denseMetadata?.embedding_usage?.actual_input_tokens ?? null,
      embedding_estimated_cost_usd:
        denseMetadata?.embedding_usage?.estimated_cost_usd ?? null,
      embedding_estimated_input_tokens:
        denseMetadata?.embedding_usage?.estimated_input_tokens ?? null,
      embedding_usage_estimated:
        denseMetadata?.embedding_usage?.source === 'estimated',
      index_versions: denseMetadata?.index_versions ?? [],
      canonical_state: canonicalState,
      canonical_latency_ms: canonicalLatency,
      canonical_count:
        canonicalPath === 'hybrid' ? context.items.length : legacyCount,
      canonical_error_code: canonicalErrorCode,
      canonical_error_message: canonicalErrorMessage,
      shadow_state: shadowState,
      shadow_latency_ms: shadowLatency,
      shadow_count:
        canonicalPath === 'hybrid' ? legacyCount : context.items.length,
      shadow_error_code: shadowErrorCode,
      shadow_error_message: shadowErrorMessage,
      candidates: expanded,
      evidence: context.items,
    });

    return {
      run_id: runId,
      state,
      error_code: errorCode,
      error_message: errorMessage,
      evidence: context.items,
      used_tokens: context.used_tokens,
      canonical_path: canonicalPath,
      shadow_state: shadowState,
      legacy_candidates:
        legacyResult.result.ok && legacyResult.result.value
          ? legacyResult.result.value
          : [],
      legacy_state: legacyState,
      legacy_error_code: legacyErrorCode,
      legacy_error_message: legacyErrorMessage,
      sparse_ranked_chunk_ids: sparseCandidates.map(
        (candidate) => candidate.chunk_id,
      ),
      dense_ranked_chunk_ids: denseCandidates.map(
        (candidate) => candidate.chunk_id,
      ),
      embedding_cost_usd:
        denseMetadata?.embedding_usage?.cost_usd ??
        denseMetadata?.embedding_usage?.estimated_cost_usd ??
        null,
    };
  }
}

function rerankLocally(
  candidates: FusedCandidate[],
  queryTerms: string[],
): FusedCandidate[] {
  return candidates
    .map((candidate) => {
      const normalized =
        `${candidate.heading_path.join(' ')} ${candidate.content}`.toLowerCase();
      const lexicalMatches = queryTerms.filter((term) =>
        normalized.includes(term.toLowerCase()),
      ).length;
      return {
        ...candidate,
        rerank_score:
          candidate.fusion_score +
          lexicalMatches / Math.max(1, queryTerms.length),
      };
    })
    .sort(
      (left, right) =>
        right.rerank_score - left.rerank_score ||
        left.chunk_id.localeCompare(right.chunk_id),
    )
    .map((candidate, index) => ({
      ...candidate,
      rerank_rank: index + 1,
    }));
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

async function timedSettle<T>(
  promise: Promise<T>,
): Promise<{ result: Settled<T>; latency_ms: number }> {
  const startedAt = Date.now();
  return {
    result: await settle(promise),
    latency_ms: Date.now() - startedAt,
  };
}

function failureMessage<T>(result: Settled<T>): string | null {
  if (result.ok) return null;
  return result.error instanceof Error
    ? result.error.message
    : String(result.error);
}
