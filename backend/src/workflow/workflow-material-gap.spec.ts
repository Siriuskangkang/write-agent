import {
  GroundingRevisionRequiredError,
  MaterialGapError,
} from '../citation/material-gap.error.js';
import { MysqlWorkflowExecutionStore } from './mysql-workflow-execution.store.js';
import { AtomicGroundingRuntimeError } from './workflow-generation.executor.js';
import type { ClaimedWorkflowJob } from './workflow.engine.js';
import { WorkflowStatus, WorkflowType } from './workflow.types.js';

describe('MysqlWorkflowExecutionStore material-gap pause', () => {
  it.each([
    [
      'RECOVERY_ASSIGNMENT_DRIFT',
      WorkflowStatus.WAITING_MATERIAL,
      'MATERIAL_GAP',
    ],
    [
      'ATOMIC_GROUNDING_DISABLED',
      WorkflowStatus.FAILED,
      'ATOMIC_GROUNDING_UNAVAILABLE',
    ],
    ['INTERNAL_FAIL_CLOSED', WorkflowStatus.FAILED, 'ATOMIC_GROUNDING_FAILED'],
    [
      'ATOMIC_COMMIT_NOT_AUTHORIZED',
      WorkflowStatus.FAILED,
      'ATOMIC_COMMIT_NOT_AUTHORIZED',
    ],
  ] as const)(
    'persists exact atomic reason/public transition for %s',
    async (reason, expectedStatus, expectedPublicCode) => {
      const state = {
        status: WorkflowStatus.RUNNING as string,
        checkpoint: null as Record<string, unknown> | null,
        errorCode: null as string | null,
        publicCode: null as string | null,
      };
      const events: Array<{
        type: string;
        data: Record<string, unknown> | null;
      }> = [];
      const manager = {
        query: jest.fn(async (sql: string, parameters?: unknown[]) => {
          await Promise.resolve();
          if (sql.includes('SELECT *')) {
            return [
              {
                id: 'job-1',
                status: state.status,
                checkpoint: state.checkpoint,
                cancel_requested_at: null,
                lease_token: 'lease-1',
                fencing_token: 2,
                lease_active: 1,
              },
            ];
          }
          if (sql.includes('UPDATE workflow_jobs')) {
            state.status = String(parameters?.[0]);
            state.errorCode = String(parameters?.[1]);
            state.publicCode = String(parameters?.[3]);
            const checkpointParameter = parameters?.[5];
            if (
              typeof checkpointParameter === 'string' &&
              checkpointParameter.startsWith('{')
            ) {
              state.checkpoint = JSON.parse(checkpointParameter) as Record<
                string,
                unknown
              >;
            }
            return { affectedRows: 1 };
          }
          if (sql.includes('MAX(seq)')) return [{ maxSeq: events.length }];
          return [];
        }),
        getRepository: () => ({
          create: (value: {
            type: string;
            data: Record<string, unknown> | null;
          }) => value,
          save: async (value: {
            type: string;
            data: Record<string, unknown> | null;
          }) => {
            events.push(value);
            return Promise.resolve(value);
          },
        }),
      };
      const store = new MysqlWorkflowExecutionStore({
        transaction: async <T>(
          callback: (value: typeof manager) => Promise<T>,
        ): Promise<T> => callback(manager),
      } as never);
      await store.fail(
        atomicJob(),
        new AtomicGroundingRuntimeError(reason, 0, ['candidate-key-1']),
      );

      expect(state).toMatchObject({
        status: expectedStatus,
        errorCode: reason,
        publicCode: expectedPublicCode,
      });
      expect(state.checkpoint).toMatchObject({
        atomic_failure_reason: reason,
        candidate_claim_keys: ['candidate-key-1'],
      });
      expect(JSON.stringify(events)).not.toContain('claim text');
      const failureEvent = events.find(
        (event) => event.data?.reason === reason,
      );
      expect(failureEvent?.data).toMatchObject({
        error_code: expectedPublicCode,
        reason,
      });
    },
  );

  it('rejects forged atomic public code and transition instead of persisting caller fields', async () => {
    const state = {
      status: WorkflowStatus.RUNNING as string,
      errorCode: null as string | null,
      publicCode: null as string | null,
    };
    const manager = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        await Promise.resolve();
        if (sql.includes('SELECT *')) {
          return [
            {
              id: 'job-1',
              status: state.status,
              checkpoint: null,
              cancel_requested_at: null,
              lease_token: 'lease-1',
              fencing_token: 2,
              lease_active: 1,
            },
          ];
        }
        if (sql.includes('UPDATE workflow_jobs')) {
          state.status = String(parameters?.[0]);
          state.errorCode = String(parameters?.[1]);
          state.publicCode = String(parameters?.[3]);
          return { affectedRows: 1 };
        }
        if (sql.includes('MAX(seq)')) return [{ maxSeq: 0 }];
        return [];
      }),
      getRepository: () => ({
        create: (value: unknown) => value,
        save: async (value: unknown) => Promise.resolve(value),
      }),
    };
    const store = new MysqlWorkflowExecutionStore({
      transaction: async <T>(
        callback: (value: typeof manager) => Promise<T>,
      ): Promise<T> => callback(manager),
    } as never);

    await store.fail(atomicJob(), {
      disposition: {
        internal_reason: 'ATOMIC_GROUNDING_DISABLED',
        public_code: 'FORGED_PUBLIC_CODE',
        transition: 'FAILED',
      },
      candidateClaimKeys: ['forged'],
    });

    expect(state).toEqual({
      status: WorkflowStatus.FAILED,
      errorCode: 'WORKFLOW_EXECUTION_FAILED',
      publicCode: 'WORKFLOW_FAILED',
    });
  });

  it('persists WAITING_MATERIAL and a safe event instead of FAILED', async () => {
    const state = {
      status: WorkflowStatus.RUNNING as string,
      errorCode: null as string | null,
      publicCode: null as string | null,
    };
    const eventTypes: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        await Promise.resolve();
        if (sql.includes('SELECT *')) {
          return [
            {
              id: 'job-1',
              status: state.status,
              cancel_requested_at: null,
              lease_token: 'lease-1',
              fencing_token: 2,
              lease_active: 1,
            },
          ];
        }
        if (sql.includes('UPDATE workflow_jobs')) {
          state.status = String(parameters?.[0]);
          state.errorCode = String(parameters?.[1]);
          state.publicCode = String(parameters?.[3]);
          return { affectedRows: 1 };
        }
        if (sql.includes('MAX(seq)')) return [{ maxSeq: eventTypes.length }];
        return [];
      }),
      getRepository: () => ({
        create: (value: { type: string }) => value,
        save: async (value: { type: string }) => {
          await Promise.resolve();
          eventTypes.push(value.type);
          return value;
        },
      }),
    };
    const dataSource = {
      transaction: async <T>(
        callback: (value: typeof manager) => Promise<T>,
      ): Promise<T> => callback(manager),
    };
    const store = new MysqlWorkflowExecutionStore(dataSource as never);
    const job: ClaimedWorkflowJob = {
      id: 'job-1',
      userId: 'user-1',
      projectId: 'project-1',
      workflowType: WorkflowType.CONTENT,
      input: {},
      checkpoint: null,
      leaseToken: 'lease-1',
      fencingToken: 2,
      generationAttempt: 1,
    };

    await store.fail(job, new MaterialGapError('素材不足', ['claim-1']));

    expect(state).toEqual({
      status: 'WAITING_MATERIAL',
      errorCode: 'MATERIAL_GAP',
      publicCode: 'MATERIAL_GAP',
    });
    expect(eventTypes).toEqual([
      'grounding.material_gap',
      'workflow.waiting_material',
    ]);
  });

  it('atomically reserves the first atomic revision with its durable checkpoint and accepts an identical retry', async () => {
    const checkpoint = {
      phase: 'atomic_revision_required',
      generation_attempt: 1,
      revision_attempt: 1,
      canonical_proposal: {
        schema_version: 'grounded-draft.v1',
        status: 'draft',
        claims: [],
        render_fragments: [],
        ordering: [],
        material_gap: null,
      },
      candidate_claim_keys: ['candidate-key-1'],
      source_claim_texts: ['声明'],
      reason_codes: ['ATOM_EXACT_MISMATCH'],
      non_target_invariant_digests: { stable: 'a'.repeat(64) },
    };
    const state = {
      checkpoint: null as Record<string, unknown> | null,
      revisionAttempts: 0,
      snapshotDigest: 'b'.repeat(64) as string | null,
    };
    const manager = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        await Promise.resolve();
        if (sql.includes('SELECT *')) {
          return [
            {
              id: 'job-1',
              status: WorkflowStatus.RUNNING,
              checkpoint: state.checkpoint,
              cancel_requested_at: null,
              lease_token: 'lease-1',
              fencing_token: 2,
              lease_active: 1,
              generation_attempt: 1,
            },
          ];
        }
        if (sql.includes('UPDATE grounding_assignments')) {
          if (state.revisionAttempts !== 0) return { affectedRows: 0 };
          state.revisionAttempts = 1;
          state.snapshotDigest = null;
          return { affectedRows: 1 };
        }
        if (
          sql.includes('SELECT targeted_revision_attempts') &&
          sql.includes('grounding_assignments')
        ) {
          return [
            {
              targeted_revision_attempts: state.revisionAttempts,
              contract_version: 'atomic:v1',
              strict_mode: 1,
            },
          ];
        }
        if (sql.includes('UPDATE workflow_jobs')) {
          state.checkpoint = JSON.parse(String(parameters?.[0])) as Record<
            string,
            unknown
          >;
          return { affectedRows: 1 };
        }
        if (sql.includes('MAX(seq)')) return [{ maxSeq: 0 }];
        return [];
      }),
      getRepository: () => ({
        create: (value: unknown) => value,
        save: async (value: unknown) => Promise.resolve(value),
      }),
    };
    const store = new MysqlWorkflowExecutionStore({
      transaction: async <T>(
        callback: (value: typeof manager) => Promise<T>,
      ): Promise<T> => callback(manager),
    } as never);
    const claimed = atomicJob();

    await store.persistProgress(
      claimed,
      'grounding.revision_required',
      { type: 'revision_required' },
      checkpoint,
    );
    await store.persistProgress(
      claimed,
      'grounding.revision_required',
      { type: 'revision_required' },
      checkpoint,
    );

    expect(state.revisionAttempts).toBe(1);
    expect(state.snapshotDigest).toBeNull();
    expect(state.checkpoint).toEqual(checkpoint);
  });

  it('persists an atomic REVISION_REQUIRED checkpoint and increments one attempt', async () => {
    const state = {
      status: WorkflowStatus.RUNNING as string,
      checkpoint: {
        phase: 'model_completed',
        generation_attempt: 1,
        output: '不支持的声明。',
      } as Record<string, unknown>,
      revisionAttempts: 0,
    };
    const eventTypes: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        await Promise.resolve();
        if (sql.includes('SELECT *')) {
          return [
            {
              id: 'job-1',
              status: state.status,
              checkpoint: state.checkpoint,
              cancel_requested_at: null,
              lease_token: 'lease-1',
              fencing_token: 2,
              lease_active: 1,
            },
          ];
        }
        if (sql.includes('UPDATE grounding_assignments')) {
          state.revisionAttempts += 1;
          return { affectedRows: 1 };
        }
        if (sql.includes('UPDATE workflow_jobs')) {
          state.status = String(parameters?.[0]);
          state.checkpoint = JSON.parse(String(parameters?.[1])) as Record<
            string,
            unknown
          >;
          return { affectedRows: 1 };
        }
        if (sql.includes('MAX(seq)')) return [{ maxSeq: eventTypes.length }];
        return [];
      }),
      getRepository: () => ({
        create: (value: { type: string }) => value,
        save: async (value: { type: string }) => {
          eventTypes.push(value.type);
          return Promise.resolve(value);
        },
      }),
    };
    const dataSource = {
      transaction: async <T>(
        callback: (value: typeof manager) => Promise<T>,
      ): Promise<T> => callback(manager),
    };
    const store = new MysqlWorkflowExecutionStore(dataSource as never);
    const job: ClaimedWorkflowJob = {
      id: 'job-1',
      userId: 'user-1',
      projectId: 'project-1',
      workflowType: WorkflowType.CONTENT,
      input: {},
      checkpoint: state.checkpoint,
      leaseToken: 'lease-1',
      fencingToken: 2,
      generationAttempt: 1,
    };

    await store.fail(
      job,
      new GroundingRevisionRequiredError([
        { claim_id: 'claim-1', claim_text: '不支持的声明。' },
      ]),
    );

    expect(state.status).toBe('REVISION_REQUIRED');
    expect(state.revisionAttempts).toBe(1);
    expect(state.checkpoint).toMatchObject({
      phase: 'revision_required',
      revision_attempt: 1,
      unsupported_claims: [
        { claim_id: 'claim-1', claim_text: '不支持的声明。' },
      ],
    });
    expect(eventTypes).toEqual(['grounding.revision_required']);
  });

  it('falls back to WAITING_MATERIAL when the single revision attempt is already reserved', async () => {
    const eventTypes: string[] = [];
    let status: string = WorkflowStatus.RUNNING;
    const manager = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        await Promise.resolve();
        if (sql.includes('SELECT *')) {
          return [
            {
              id: 'job-1',
              status,
              checkpoint: null,
              cancel_requested_at: null,
              lease_token: 'lease-1',
              fencing_token: 2,
              lease_active: 1,
            },
          ];
        }
        if (sql.includes('UPDATE grounding_assignments')) {
          return { affectedRows: 0 };
        }
        if (sql.includes('UPDATE workflow_jobs')) {
          status = String(parameters?.[0]);
          return { affectedRows: 1 };
        }
        if (sql.includes('MAX(seq)')) return [{ maxSeq: eventTypes.length }];
        return [];
      }),
      getRepository: () => ({
        create: (value: { type: string }) => value,
        save: async (value: { type: string }) => {
          eventTypes.push(value.type);
          return Promise.resolve(value);
        },
      }),
    };
    const dataSource = {
      transaction: async <T>(
        callback: (value: typeof manager) => Promise<T>,
      ): Promise<T> => callback(manager),
    };
    const store = new MysqlWorkflowExecutionStore(dataSource as never);

    await store.fail(
      {
        id: 'job-1',
        userId: 'user-1',
        projectId: 'project-1',
        workflowType: WorkflowType.CONTENT,
        input: {},
        checkpoint: null,
        leaseToken: 'lease-1',
        fencingToken: 2,
        generationAttempt: 1,
      },
      new GroundingRevisionRequiredError([
        { claim_id: 'claim-1', claim_text: '仍然缺少证据。' },
      ]),
    );

    expect(status).toBe(WorkflowStatus.WAITING_MATERIAL);
    expect(eventTypes).toEqual([
      'grounding.material_gap',
      'workflow.waiting_material',
    ]);
  });
});

function atomicJob(): ClaimedWorkflowJob {
  return {
    id: 'job-1',
    userId: 'user-1',
    projectId: 'project-1',
    workflowType: WorkflowType.CONTENT,
    input: { strict_citation: true },
    checkpoint: null,
    leaseToken: 'lease-1',
    fencingToken: 2,
    generationAttempt: 1,
  };
}
