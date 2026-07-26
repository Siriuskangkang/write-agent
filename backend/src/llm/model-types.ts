export type ModelRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelMessage {
  role: ModelRole;
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface ModelTraceMetadata {
  workflow_job_id: string;
  node: string;
  attempt: number;
  trace_id?: string;
}

/**
 * Provider-independent structured output contract. The parser is both the
 * runtime validator and the source of the inferred output type.
 */
export interface StructuredOutputSchema<T> {
  id: string;
  version?: string;
  json_schema?: Readonly<Record<string, unknown>>;
  parse: (value: unknown) => T;
}

export type InferStructuredOutput<TSchema> =
  TSchema extends StructuredOutputSchema<infer TOutput> ? TOutput : never;

export type ModelResponseMode = 'text' | 'structured' | 'tool';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Readonly<Record<string, unknown>>;
}

export type ModelToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { readonly name: string };

export interface ModelRequest<TOutput = unknown> {
  messages: readonly ModelMessage[];
  idempotency_key?: string;
  response_mode?: ModelResponseMode;
  schema?: StructuredOutputSchema<TOutput>;
  tools?: readonly ToolDefinition[];
  tool_choice?: ModelToolChoice;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
  signal?: AbortSignal;
  trace?: ModelTraceMetadata;
  max_retries?: number;
  max_repair_attempts?: number;
  retry_base_delay_ms?: number;
}

export interface ModelOperationIdentity {
  version: 'model-operation.v1';
  operation_key: string;
  request_fingerprint: string;
  prompt_sha256: string;
  provider: string;
  model: string;
  schema_id: string | null;
  schema_version: string | null;
  schema_sha256: string | null;
}

export type ModelOperationMatchIdentity = Omit<
  ModelOperationIdentity,
  'version' | 'operation_key'
>;

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments_json: string;
  index: number;
}

/**
 * Only explicit provider terminal states that represent a complete response.
 * Provider-specific truncation, filtering and unknown states are normalized to
 * ModelError instead of being admitted as successful completion reasons.
 */
export type ModelFinishReason = 'stop' | 'tool_call';

export interface ModelCompletionAudit {
  repair_attempts: number;
  response_utf8_bytes: number;
  final_model_run_id: string | null;
}

export interface ModelError {
  code:
    | 'ABORTED'
    | 'TIMEOUT'
    | 'RATE_LIMITED'
    | 'PROVIDER_UNAVAILABLE'
    | 'NETWORK_ERROR'
    | 'BAD_REQUEST'
    | 'AUTHENTICATION_FAILED'
    | 'STRUCTURED_OUTPUT_INVALID'
    | 'INCOMPLETE_OUTPUT'
    | 'CONTENT_FILTERED'
    | 'UNEXPECTED_TOOL_CALL'
    | 'TOOL_CALL_REQUIRED'
    | 'PROVIDER_ERROR';
  message: string;
  retryable: boolean;
  status?: number;
  retry_after_ms?: number;
  details?: string;
}

export type ModelEvent<TOutput = unknown> =
  | { type: 'text_delta'; text: string; attempt: number }
  | { type: 'tool_call'; tool_call: ModelToolCall; attempt: number }
  | { type: 'usage'; usage: ModelUsage; attempt: number }
  | {
      type: 'completed';
      finish_reason: ModelFinishReason;
      structured_output?: TOutput;
      gateway_audit?: ModelCompletionAudit;
      attempt: number;
    }
  | { type: 'error'; error: ModelError; attempt: number };

export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  stream(request: ModelRequest, attempt: number): AsyncIterable<ModelEvent>;
}

export function isModelTextDelta(
  event: ModelEvent,
): event is Extract<ModelEvent, { type: 'text_delta' }> {
  return event.type === 'text_delta';
}
