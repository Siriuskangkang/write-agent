/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import type { ConfigService } from '@nestjs/config';
import type { LLMFactory } from '../../llm/llm.factory.js';
import { ModelGateway, ModelGatewayError } from '../../llm/model-gateway.js';
import {
  ModelPricingCatalog,
  type ModelRunRecorder,
} from '../../llm/model-pricing.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
} from '../../llm/model-types.js';
import type { GroundedDraftProposal } from '../../citation/atomic-grounding/contracts.js';
import { GROUNDED_DRAFT_SCHEMA } from '../../citation/atomic-grounding/grounded-draft.schema.js';
import {
  groundedDraftChain,
  type GroundedDraftModelInput,
} from './grounded-draft.chain.js';

const proposal: GroundedDraftProposal = {
  schema_version: 'grounded-draft.v1',
  status: 'draft',
  claims: [
    {
      proposal_claim_id: 'claim-1',
      revision_of_candidate_claim_key: null,
      claim_text: '系统容量为300MW。',
      span: { fragment_id: 'claim-fragment', start_utf16: 0, end_utf16: 11 },
      subject: { surface: '系统', start_utf16: 0, end_utf16: 2 },
      predicate: { surface: '容量为', start_utf16: 2, end_utf16: 5 },
      polarity: 'affirmed',
      quantifier: 'plain',
      quantities: [
        {
          quantity_id: 'quantity-1',
          surface: '300MW',
          start_utf16: 5,
          end_utf16: 10,
          dimension: 'power',
          value: '300',
          unit: 'MW',
          comparator: 'eq',
          range_end: null,
        },
      ],
      evidence_ids: ['evidence-allowed'],
    },
  ],
  render_fragments: [
    {
      fragment_id: 'heading-fragment',
      kind: 'structure_ref',
      structure_id: 'structure-allowed',
      presentation: 'heading_2',
    },
    {
      fragment_id: 'claim-fragment',
      kind: 'claim_ref',
      claim_id: 'claim-1',
      presentation: 'sentence',
    },
  ],
  ordering: ['heading-fragment', 'claim-fragment'],
  material_gap: null,
};

const input: GroundedDraftModelInput = {
  workflow_type: 'content',
  workflow_job_id: '11111111-1111-4111-8111-111111111111',
  generation_attempt: 2,
  revision_attempt: 0,
  authoring_context: {
    project_name: '教材项目',
    chapter_title: '第一章',
  },
  approved_render_context: {
    context_version: 'approved-render-context.v1',
    entries: [
      {
        structure_id: 'structure-allowed',
        source_kind: 'directory',
        source_id: 'directory-version-1',
        source_version: '3',
        label_nfc: '第一章',
        presentation: 'heading_2',
      },
    ],
  },
  evidence: [
    {
      evidence_id: 'evidence-allowed',
      exact_span_text: '系统容量为300MW。',
      source_boundary: 'untrusted_evidence',
    },
  ],
};

describe('groundedDraftChain', () => {
  it('uses the closed structured schema and preserves gateway-owned audit', async () => {
    const encoded = JSON.stringify(proposal);
    const adapter = scriptedAdapter([
      () =>
        events({ type: 'text_delta', text: encoded, attempt: 0 }, {
          type: 'completed',
          finish_reason: 'stop',
          attempt: 0,
          gateway_audit: {
            repair_attempts: 99,
            response_utf8_bytes: 1,
            final_model_run_id: 'forged',
          },
        } as ModelEvent),
    ]);
    const recorder = fakeRecorder();
    const gateway = createGateway(adapter, recorder);
    const signal = new AbortController().signal;
    const trace = {
      workflow_job_id: input.workflow_job_id,
      node: 'atomic_grounded_draft',
      attempt: 2,
    } as const;

    const result = await groundedDraftChain(gateway, input, {
      signal,
      timeout_ms: 12_345,
      trace,
    });

    expect(result).toEqual({
      proposal,
      audit: {
        repair_attempts: 0,
        proposal_bytes: Buffer.byteLength(encoded, 'utf8'),
        model_run_id: 'run-1',
      },
    });
    const request = adapter.stream.mock.calls[0][0];
    expect(request).toEqual(
      expect.objectContaining({
        response_mode: 'structured',
        schema: GROUNDED_DRAFT_SCHEMA,
        max_repair_attempts: 1,
        max_retries: 2,
        timeout_ms: 12_345,
        signal: expect.any(AbortSignal),
        trace,
      }),
    );
    expect(request.max_tokens).toEqual(expect.any(Number));
    expect(request.max_tokens).toBeGreaterThan(0);
    expect(request.max_tokens).toBeLessThanOrEqual(16_384);
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]).toEqual(
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('untrusted'),
      }),
    );
    const serializedPrompt = JSON.stringify(request.messages);
    expect(serializedPrompt).toContain('evidence-allowed');
    expect(serializedPrompt).toContain('structure-allowed');
    expect(serializedPrompt).not.toContain(input.workflow_job_id);
    expect(serializedPrompt).not.toContain('forged');
  });

  it('binds revision generation to one stable provider request without replay or repair', async () => {
    const encoded = JSON.stringify(proposal);
    const adapter = scriptedAdapter([
      () =>
        events(
          { type: 'text_delta', text: encoded, attempt: 0 },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());
    const requestIdempotencyKey = 'a'.repeat(64);
    const revisionInput: GroundedDraftModelInput = {
      ...input,
      revision_attempt: 1,
      revision: {
        base_proposal: proposal,
        allowed_candidate_claim_keys: ['candidate-key-1'],
        non_target_invariant_digests: {},
      },
    };
    const options = {
      signal: new AbortController().signal,
      trace: {
        workflow_job_id: input.workflow_job_id,
        node: 'atomic_grounded_revision',
        attempt: 2,
      },
      request_idempotency_key: requestIdempotencyKey,
    };

    await groundedDraftChain(gateway, revisionInput, options);

    const request = adapter.stream.mock.calls[0][0] as ModelRequest & {
      idempotency_key?: string;
    };
    expect(request).toMatchObject({
      idempotency_key: requestIdempotencyKey,
      max_retries: 0,
      max_repair_attempts: 0,
    });
    expect(adapter.stream).toHaveBeenCalledTimes(1);
  });

  it('repairs once without exposing structured JSON as a text completion', async () => {
    const encoded = JSON.stringify(proposal);
    const adapter = scriptedAdapter([
      () =>
        events(
          { type: 'text_delta', text: '{"status":"draft"}', attempt: 0 },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
      () =>
        events(
          { type: 'text_delta', text: encoded, attempt: 0 },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());

    const result = await groundedDraftChain(gateway, input, {
      trace: {
        workflow_job_id: input.workflow_job_id,
        node: 'atomic_grounded_draft',
        attempt: 2,
      },
    });

    expect(result.audit).toEqual({
      repair_attempts: 1,
      proposal_bytes: Buffer.byteLength(encoded, 'utf8'),
      model_run_id: 'run-2',
    });
    expect(adapter.stream).toHaveBeenCalledTimes(2);
  });

  it('fails after the single schema repair and never falls back to text', async () => {
    const adapter = scriptedAdapter([
      () =>
        events(
          { type: 'text_delta', text: 'invalid-one', attempt: 0 },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
      () =>
        events(
          { type: 'text_delta', text: 'invalid-two', attempt: 0 },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
    ]);

    await expect(
      groundedDraftChain(createGateway(adapter, fakeRecorder()), input, {}),
    ).rejects.toMatchObject<ModelGatewayError>({
      modelError: { code: 'STRUCTURED_OUTPUT_INVALID' },
    });
    expect(adapter.stream).toHaveBeenCalledTimes(2);
    expect(
      adapter.stream.mock.calls.map(([request]) => request.response_mode),
    ).toEqual(['structured', 'structured']);
  });

  it('sends only the allowlisted evidence payload and sealed structure payload', async () => {
    const encoded = JSON.stringify(proposal);
    const adapter = scriptedAdapter([
      () =>
        events(
          { type: 'text_delta', text: encoded, attempt: 0 },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
    ]);
    const taintedInput = {
      ...input,
      evidence: [
        {
          ...input.evidence[0],
          literal: 'MUST_NOT_LEAK_LITERAL',
          score: 0.99,
          retrieval_run_id: 'MUST_NOT_LEAK_RUN',
          exact_span_document_start: 17,
        },
      ],
      approved_render_context: {
        ...input.approved_render_context,
        entries: [
          {
            ...input.approved_render_context.entries[0],
            secret_status: 'MUST_NOT_LEAK_STATUS',
          },
        ],
      },
      revision: {
        base_proposal: proposal,
        allowed_candidate_claim_keys: ['candidate-allowed'],
        non_target_invariant_digests: {},
        provider_raw_output: 'MUST_NOT_LEAK_PROVIDER_OUTPUT',
      },
    } as GroundedDraftModelInput;

    await groundedDraftChain(
      createGateway(adapter, fakeRecorder()),
      taintedInput,
      {},
    );

    const prompt = JSON.stringify(adapter.stream.mock.calls[0][0].messages);
    expect(prompt).toContain('UNTRUSTED_EVIDENCE_START');
    expect(prompt).toContain('UNTRUSTED_EVIDENCE_END');
    expect(prompt).not.toContain('MUST_NOT_LEAK_LITERAL');
    expect(prompt).not.toContain('MUST_NOT_LEAK_RUN');
    expect(prompt).not.toContain('MUST_NOT_LEAK_STATUS');
    expect(prompt).not.toContain('MUST_NOT_LEAK_PROVIDER_OUTPUT');
    expect(prompt).not.toContain('exact_span_document_start');
  });
});

function createGateway(
  adapter: jest.Mocked<ModelAdapter>,
  recorder: ReturnType<typeof fakeRecorder>,
): ModelGateway {
  const factory = {
    createProvider: jest.fn(() => adapter),
  } as unknown as LLMFactory;
  const configService = {
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  } as unknown as ConfigService;
  return new ModelGateway(
    factory,
    recorder as unknown as ModelRunRecorder,
    new ModelPricingCatalog(configService),
  );
}

function scriptedAdapter(
  scripts: Array<() => AsyncIterable<ModelEvent>>,
): jest.Mocked<ModelAdapter> {
  let index = 0;
  return {
    provider: 'fake',
    model: 'model-1',
    stream: jest.fn((request: ModelRequest) => {
      void request;
      const script = scripts[index++];
      if (!script) throw new Error('unexpected attempt');
      return script();
    }),
  };
}

function fakeRecorder() {
  let counter = 0;
  return {
    startAttempt: jest.fn(() => Promise.resolve({ id: `run-${++counter}` })),
    finishAttempt: jest.fn(() => Promise.resolve()),
  };
}

function events(...items: ModelEvent[]): AsyncIterable<ModelEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield* items;
    },
  };
}
