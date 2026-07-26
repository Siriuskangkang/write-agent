export type RetrievalTaskType = 'directory' | 'outline' | 'content';
export type RetrievalState = 'READY' | 'DEGRADED' | 'NO_HIT' | 'ERROR';

export interface RetrievalQueryPlan {
  task_type: RetrievalTaskType;
  intent: 'structure' | 'coverage' | 'explanation';
  original_query: string;
  sparse_query: string;
  dense_query: string;
  terms: string[];
}

export interface RetrievalCandidate {
  chunk_id: string;
  project_id: string;
  file_id: string;
  document_id: string;
  ingestion_key: string | null;
  content: string;
  section_title: string | null;
  heading_path: string[];
  page_start: number | null;
  page_end: number | null;
  char_start: number | null;
  char_end: number | null;
  position: number;
  token_count: number;
  file_name?: string;
  keywords?: string[];
  source: 'sparse' | 'dense' | 'neighbor';
  source_score: number;
  embedding?: number[];
}

export interface FusedCandidate extends RetrievalCandidate {
  sparse_rank: number | null;
  sparse_score: number | null;
  dense_rank: number | null;
  dense_score: number | null;
  fusion_score: number;
  fusion_rank: number;
  rerank_score: number;
  rerank_rank: number;
}

export interface EvidenceItem {
  evidence_id: string;
  chunk_id: string;
  content: string;
  exact_span: {
    text: string;
    char_start: number | null;
    char_end: number | null;
  };
  source: {
    file_id: string;
    file_name?: string;
    document_id: string;
    ingestion_key: string | null;
    page_start: number | null;
    page_end: number | null;
    section_title: string | null;
    heading_path: string[];
    keywords?: string[];
  };
  scores: {
    sparse: number | null;
    dense: number | null;
    fusion: number;
    rerank: number;
  };
  ranks: {
    sparse: number | null;
    dense: number | null;
    fusion: number;
    rerank: number;
  };
  token_count: number;
}

export interface SparseSearchRequest {
  project_id: string;
  sparse_query: string;
  limit: number;
}

export interface SparseRetrieverPort {
  search(request: SparseSearchRequest): Promise<RetrievalCandidate[]>;
}

export interface DenseSearchResult {
  candidates: RetrievalCandidate[];
  state: 'ready' | 'unavailable';
  error_code: string | null;
  query_embedding?: number[] | null;
  index_versions?: DenseIndexSnapshot[];
  embedding_usage?: {
    model: string;
    actual_input_tokens: number | null;
    estimated_input_tokens: number | null;
    cost_usd: string | null;
    estimated_cost_usd: string | null;
    source: 'actual' | 'estimated';
  } | null;
}

export interface DenseIndexSnapshot {
  id: string | null;
  file_id: string;
  ingestion_key: string;
  index_version: string;
  status: string;
  collection_name: string | null;
  embedding_model: string | null;
  embedding_dimension: number | null;
  namespace: string | null;
  expected_point_count: number;
  observed_point_count: number | null;
}

export interface DenseIndexClaim {
  id: string;
  file_id: string;
  ingestion_key: string;
  index_version: string;
  status: string;
  project_id: string;
  document_id: string;
  chunk_version: string;
  collection_name: string;
  embedding_model: string;
  embedding_dimension: number;
  attempt_token: string;
  attempt_count: number;
}

export interface DenseIndexRetentionDebt {
  id: string;
  file_id: string;
  namespace: string;
  reason: 'REACTIVATABLE_NAMESPACE_RETAINED';
}

export interface DenseRetrieverPort {
  search(
    request: RetrievalQueryPlan & { project_id: string; limit: number },
  ): Promise<DenseSearchResult>;
}

export interface LegacyRetrieverPort {
  search(request: {
    project_id: string;
    terms: string[];
    limit: number;
  }): Promise<RetrievalCandidate[]>;
}

export interface RetrievalRunStart {
  project_id: string;
  query: string;
  task_type: RetrievalTaskType;
  plan: RetrievalQueryPlan;
  mode: 'legacy' | 'shadow' | 'hybrid';
  gate_decision: boolean;
  canonical_path: 'hybrid' | 'legacy_like';
  shadow_path: 'hybrid' | 'legacy_like' | null;
  top_k?: number;
  token_budget?: number;
  workflow_job_id?: string;
  revision_attempt?: 1;
}

export type IdempotentRetrievalStart =
  | { kind: 'started'; run_id: string }
  | { kind: 'recovered'; result: HybridRetrievalResult };

export interface RetrievalRunCompletion {
  state: RetrievalState;
  error_code: string | null;
  error_message: string | null;
  latency_ms: number;
  sparse_count: number;
  dense_count: number;
  fused_count: number;
  legacy_count: number;
  selected_count: number;
  embedding_cost_usd: string | null;
  embedding_input_tokens: number | null;
  embedding_estimated_cost_usd: string | null;
  embedding_estimated_input_tokens: number | null;
  embedding_usage_estimated: boolean;
  index_versions: DenseIndexSnapshot[];
  canonical_state: RetrievalState;
  canonical_latency_ms: number;
  canonical_count: number;
  canonical_error_code: string | null;
  canonical_error_message: string | null;
  shadow_state: RetrievalState | null;
  shadow_latency_ms: number | null;
  shadow_count: number;
  shadow_error_code: string | null;
  shadow_error_message: string | null;
  candidates: FusedCandidate[];
  evidence: EvidenceItem[];
}

export interface RetrievalRunRecorder {
  start(input: RetrievalRunStart): Promise<string>;
  startIdempotent?(input: RetrievalRunStart): Promise<IdempotentRetrievalStart>;
  complete(runId: string, input: RetrievalRunCompletion): Promise<void>;
}

export interface IndexVersionRecorder {
  claimDispatchBatch(limit: number): Promise<DenseIndexClaim[]>;
  releaseDispatchClaim(
    id: string,
    attemptToken: string,
    errorMessage: string,
  ): Promise<void>;
  beginAttempt(
    id: string,
    attemptToken: string,
  ): Promise<DenseIndexClaim | null>;
  isAttemptActive(id: string, attemptToken: string): Promise<boolean>;
  renewAttemptLease(id: string, attemptToken: string): Promise<boolean>;
  attemptFenceState(
    id: string,
    attemptToken: string,
  ): Promise<'ACTIVE' | 'STALE_INGESTION' | 'LEASE_EXPIRED' | 'SUPERSEDED'>;
  markReady(
    id: string,
    attemptToken: string,
    input: { point_count: number; indexed_at: Date },
  ): Promise<boolean>;
  markFailed(
    id: string,
    attemptToken: string,
    input: { error_code: string; error_message: string },
  ): Promise<boolean>;
  recordRetentionDebtBatch(limit: number): Promise<DenseIndexRetentionDebt[]>;
}

export interface HybridRetrievalRequest {
  project_id: string;
  query: string;
  task_type: RetrievalTaskType;
  top_k: number;
  token_budget: number;
  mode?: 'shadow' | 'hybrid';
  gate_decision?: boolean;
  workflow_job_id?: string;
  revision_attempt?: 1;
}

export interface HybridRetrievalResult {
  run_id: string;
  state: RetrievalState;
  error_code: string | null;
  error_message: string | null;
  evidence: EvidenceItem[];
  used_tokens: number;
  canonical_path?: 'hybrid' | 'legacy_like';
  shadow_state?: RetrievalState | null;
  legacy_candidates?: RetrievalCandidate[];
  legacy_state?: RetrievalState;
  legacy_error_code?: string | null;
  legacy_error_message?: string | null;
  sparse_ranked_chunk_ids?: string[];
  dense_ranked_chunk_ids?: string[];
  embedding_cost_usd?: string | null;
}
