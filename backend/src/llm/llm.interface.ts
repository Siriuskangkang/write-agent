export interface LLMTextDeltaEvent {
  type: 'content_block_delta';
  delta: { type: 'text_delta'; text: string };
}

export type LLMStreamEvent =
  | LLMTextDeltaEvent
  | { type: string; delta?: unknown };

export function isLLMTextDeltaEvent(
  event: LLMStreamEvent,
): event is LLMTextDeltaEvent {
  if (event.type !== 'content_block_delta') return false;
  const delta = event.delta;
  return (
    typeof delta === 'object' &&
    delta !== null &&
    (delta as { type?: unknown }).type === 'text_delta' &&
    typeof (delta as { text?: unknown }).text === 'string'
  );
}

export interface LLMProvider {
  streamCompletion(
    prompt: string,
    systemPrompt?: string,
    temperature?: number,
    options?: LLMStreamOptions,
  ): AsyncIterable<LLMStreamEvent>;
}

export interface LLMStreamOptions {
  signal?: AbortSignal;
  trace?: ModelTraceMetadata;
  timeout_ms?: number;
  request_idempotency_key?: string;
}

export interface LLMConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
}
import type { ModelTraceMetadata } from './model-types.js';
