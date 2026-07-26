import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetrieveDto } from './dto/retrieve.dto.js';
import { HybridRetriever } from './hybrid-retriever.js';
import type {
  EvidenceItem,
  HybridRetrievalResult,
  LegacyRetrieverPort,
  RetrievalCandidate,
} from './types.js';
import { LEGACY_RETRIEVER } from './injection-tokens.js';
import { RagEvaluationGate } from './evaluation-gate.js';
import { planRetrievalQuery } from './query-planner.js';

export interface RetrievalResult {
  chunk_id: string;
  content: string;
  file_name: string;
  file_id: string;
  page_number: number | null;
  page_end: number | null;
  section_title: string | null;
  heading_path: string[];
  score: number;
  keywords: string[];
  retrieval_run_id: string;
  exact_span: {
    text: string;
    char_start: number | null;
    char_end: number | null;
  };
}

export interface RetrievalOperationScope {
  workflow_job_id: string;
  revision_attempt: 1;
}

@Injectable()
export class RetrievalService {
  private readonly mode: 'legacy' | 'shadow' | 'hybrid';

  constructor(
    private readonly hybrid: HybridRetriever,
    @Inject(LEGACY_RETRIEVER)
    private readonly legacy: LegacyRetrieverPort,
    config: ConfigService,
    private readonly evaluationGate: RagEvaluationGate,
  ) {
    const mode = String(config.get('RETRIEVAL_MODE', 'shadow'));
    if (mode !== 'legacy' && mode !== 'shadow' && mode !== 'hybrid') {
      throw new Error('RETRIEVAL_MODE must be legacy, shadow, or hybrid');
    }
    this.mode = mode;
  }

  async retrieve(
    projectId: string,
    dto: RetrieveDto,
  ): Promise<RetrievalResult[]> {
    const result = await this.retrieveDetailed(projectId, dto);
    return result.evidence.map((evidence) => ({
      chunk_id: evidence.chunk_id,
      content: evidence.content,
      file_name: evidence.source.file_name ?? '',
      file_id: evidence.source.file_id,
      page_number: evidence.source.page_start,
      page_end: evidence.source.page_end,
      section_title: evidence.source.section_title,
      heading_path: evidence.source.heading_path,
      score: evidence.scores.rerank,
      keywords: evidence.source.keywords ?? [],
      retrieval_run_id: result.run_id,
      exact_span: evidence.exact_span,
    }));
  }

  async retrieveDetailed(
    projectId: string,
    dto: RetrieveDto,
  ): Promise<HybridRetrievalResult> {
    if (this.mode === 'legacy') {
      const plan = planRetrievalQuery({
        query: dto.query,
        task_type: dto.task_type,
      });
      const legacy = await this.legacy.search({
        project_id: projectId,
        terms: plan.terms,
        limit: dto.top_k ?? 10,
      });
      return legacyResult(
        'legacy:unrecorded',
        legacy,
        null,
        null,
        null,
        dto.top_k ?? 10,
        6_000,
      );
    }

    const gateDecision =
      this.mode === 'hybrid' && (await this.evaluationGate.canUseHybrid());
    const result = await this.hybrid.retrieve({
      project_id: projectId,
      query: dto.query,
      task_type: dto.task_type,
      top_k: dto.top_k ?? 10,
      token_budget: 6_000,
      mode: this.mode === 'hybrid' ? 'hybrid' : 'shadow',
      gate_decision: gateDecision,
    });
    if (gateDecision) {
      return { ...result, canonical_path: 'hybrid', shadow_state: null };
    }
    return legacyResult(
      result.run_id,
      result.legacy_candidates ?? [],
      result.state,
      result.legacy_error_code ?? null,
      result.legacy_error_message ?? null,
      dto.top_k ?? 10,
      6_000,
    );
  }

  /**
   * Returns the persisted hybrid evidence packet even while the evaluated
   * hybrid path is running in shadow mode. Grounded authoring needs stable
   * evidence IDs; it does not silently promote the shadow path for general
   * retrieval responses.
   */
  async retrieveEvidenceSnapshot(
    projectId: string,
    dto: RetrieveDto,
    scope?: RetrievalOperationScope,
  ): Promise<HybridRetrievalResult> {
    if (this.mode === 'legacy') {
      throw new Error(
        'Verifiable grounding requires shadow or hybrid retrieval mode',
      );
    }
    const gateDecision =
      this.mode === 'hybrid' && (await this.evaluationGate.canUseHybrid());
    return this.hybrid.retrieve({
      project_id: projectId,
      query: dto.query,
      task_type: dto.task_type,
      top_k: dto.top_k ?? 10,
      token_budget: 6_000,
      mode: this.mode === 'hybrid' ? 'hybrid' : 'shadow',
      gate_decision: gateDecision,
      ...(scope ?? {}),
    });
  }
}

function legacyResult(
  runId: string,
  candidates: RetrievalCandidate[],
  shadowState: HybridRetrievalResult['state'] | null,
  errorCode: string | null,
  errorMessage: string | null,
  topK: number,
  tokenBudget: number,
): HybridRetrievalResult {
  const evidence: EvidenceItem[] = [];
  let usedTokens = 0;
  for (const candidate of candidates) {
    if (evidence.length >= topK) break;
    const item = toLegacyEvidence(candidate, evidence.length);
    if (usedTokens + item.token_count > tokenBudget) continue;
    evidence.push(item);
    usedTokens += item.token_count;
  }
  const failed = errorCode !== null;
  return {
    run_id: runId,
    state: failed ? 'ERROR' : evidence.length > 0 ? 'READY' : 'NO_HIT',
    error_code: errorCode,
    error_message: errorMessage,
    evidence,
    used_tokens: usedTokens,
    canonical_path: 'legacy_like',
    shadow_state: shadowState,
    legacy_candidates: candidates,
  };
}

function toLegacyEvidence(
  candidate: RetrievalCandidate,
  index: number,
): EvidenceItem {
  return {
    evidence_id: `legacy:${candidate.chunk_id}`,
    chunk_id: candidate.chunk_id,
    content: candidate.content,
    exact_span: {
      text: candidate.content,
      char_start: candidate.char_start,
      char_end: candidate.char_end,
    },
    source: {
      file_id: candidate.file_id,
      file_name: candidate.file_name,
      document_id: candidate.document_id,
      ingestion_key: candidate.ingestion_key,
      page_start: candidate.page_start,
      page_end: candidate.page_end,
      section_title: candidate.section_title,
      heading_path: candidate.heading_path,
      keywords: candidate.keywords,
    },
    scores: {
      sparse: candidate.source_score,
      dense: null,
      fusion: 0,
      rerank: candidate.source_score,
    },
    ranks: {
      sparse: index + 1,
      dense: null,
      fusion: index + 1,
      rerank: index + 1,
    },
    token_count: Math.max(1, candidate.token_count),
  };
}
