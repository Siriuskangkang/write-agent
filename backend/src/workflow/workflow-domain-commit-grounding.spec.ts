import { MaterialGapError } from '../citation/material-gap.error.js';
import type { CitationLedgerService } from '../citation/citation-ledger.service.js';
import { WorkflowDomainCommitService } from './workflow-domain-commit.service.js';
import type { ClaimedWorkflowJob } from './workflow.engine.js';
import type { WorkflowDomainCommitInput } from './workflow-domain-commit.service.js';
import { WorkflowStatus, WorkflowType } from './workflow.types.js';

describe('WorkflowDomainCommitService grounding transaction boundary', () => {
  it.each([
    ['valid envelope', {}, {}],
    ['approved_at', { approved_at: new Date('2026-07-26T00:00:00.000Z') }, {}],
    [
      'forged checkpoint capability',
      {
        checkpoint: {
          capability: 'authoring-commit-capability',
          approval_digest: 'a'.repeat(64),
        },
      },
      {},
    ],
    [
      'forged input capability',
      {},
      {
        capability: 'authoring-commit-capability',
        approval_digest: 'b'.repeat(64),
      },
    ],
  ])(
    'rejects atomic commit before every read/write boundary under %s',
    async (_label, jobPatch, inputPatch) => {
      const previousMode = process.env.ATOMIC_GROUNDING_MODE;
      process.env.ATOMIC_GROUNDING_MODE = 'enforce';
      const dataSource = {
        query: jest.fn().mockResolvedValue([]),
        transaction: jest.fn(),
      };
      const service = new WorkflowDomainCommitService(dataSource as never);
      const atomicInput = {
        contract_version: 'atomic:v1',
        sealed_candidate: {
          envelope_version: 'sealed-grounded-candidate.v1',
          contract_version: 'atomic:v1',
          server_output: { text: '不得写入' },
        },
        ...inputPatch,
      } as unknown as WorkflowDomainCommitInput;

      try {
        await expect(
          service.commit(
            {
              ...contentJob(),
              ...jobPatch,
            } as ClaimedWorkflowJob,
            atomicInput,
          ),
        ).rejects.toMatchObject({
          name: 'AtomicCommitNotAuthorizedError',
          code: 'ATOMIC_COMMIT_NOT_AUTHORIZED',
          public_code: 'ATOMIC_COMMIT_NOT_AUTHORIZED',
        });
        expect(dataSource.query).not.toHaveBeenCalled();
        expect(dataSource.transaction).not.toHaveBeenCalled();
      } finally {
        if (previousMode === undefined) {
          delete process.env.ATOMIC_GROUNDING_MODE;
        } else {
          process.env.ATOMIC_GROUNDING_MODE = previousMode;
        }
      }
    },
  );

  it('does not write a business version when strict grounding pauses', async () => {
    const writeSql: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        await Promise.resolve();
        if (sql.includes('SELECT status, cancel_requested_at')) {
          return [
            {
              status: WorkflowStatus.RUNNING,
              cancel_requested_at: null,
              lease_token: 'lease-1',
              fencing_token: 2,
              lease_active: 1,
            },
          ];
        }
        if (sql.includes('FROM workflow_domain_commits')) return [];
        writeSql.push(sql);
        return { affectedRows: 1 };
      }),
    };
    const dataSource = {
      query: jest.fn().mockResolvedValue([]),
      transaction: async <T>(
        callback: (value: typeof manager) => Promise<T>,
      ): Promise<T> => callback(manager),
    };
    const ledger = {
      prepare: jest.fn().mockRejectedValue(new MaterialGapError('素材不足')),
      persist: jest.fn(),
    };
    const service = new WorkflowDomainCommitService(
      dataSource as never,
      ledger as unknown as CitationLedgerService,
    );
    const job = contentJob();

    await expect(
      service.commit(job, {
        contract_version: 'legacy:v0',
        output: '无支持声明',
      } as WorkflowDomainCommitInput),
    ).rejects.toBeInstanceOf(MaterialGapError);
    expect(writeSql).toEqual([]);
  });
});

function contentJob(): ClaimedWorkflowJob {
  return {
    id: 'job-1',
    userId: 'user-1',
    projectId: 'project-1',
    workflowType: WorkflowType.CONTENT,
    input: {
      chapter_node_id: 'chapter-1',
      section_node_id: 'section-1',
    },
    checkpoint: null,
    leaseToken: 'lease-1',
    fencingToken: 2,
    generationAttempt: 1,
  };
}
