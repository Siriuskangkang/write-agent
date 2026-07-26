import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import type { ClaimedWorkflowJob } from '../../workflow/workflow.engine.js';
import { WorkflowType } from '../../workflow/workflow.types.js';
import {
  AuthoringProposalService,
  type PublicAuthoringProposal,
} from './authoring-proposal.service.js';
import type {
  AuthoringArtifactKind,
  AuthoringProposal,
} from './authoring-proposal.entity.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const PROPOSAL = '44444444-4444-4444-8444-444444444444';
const FOUR_MIB = 4 * 1024 * 1024;

describe('AuthoringProposalService owner and approval boundary', () => {
  it('scopes proposal reads by job, project, and owner', async () => {
    const row = proposal('ACTIVE');
    const query = jest.fn().mockResolvedValue([row]);
    const service = new AuthoringProposalService({
      query,
    } as unknown as DataSource);

    const found = await service.findActive(USER, PROJECT, JOB);

    expect(found).toBe(row);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('p.user_id=?'), [
      JOB,
      PROJECT,
      USER,
    ]);
  });

  it('fails closed when the owned job has no active proposal', async () => {
    const service = new AuthoringProposalService({
      query: jest.fn().mockResolvedValue([]),
    } as unknown as DataSource);
    await expect(service.findActive(USER, PROJECT, JOB)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('approves with proposal and job CAS, while repeated approval is idempotent', async () => {
    const active = proposal('ACTIVE');
    const approved = proposal('APPROVED');
    const firstQuery = jest
      .fn()
      .mockResolvedValueOnce([active])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([approved]);
    const first = serviceWithTransaction(firstQuery);

    await expect(first.approve(USER, PROJECT, JOB)).resolves.toMatchObject({
      id: PROPOSAL,
      status: 'APPROVED',
    });
    expect(firstQuery).toHaveBeenCalledWith(
      expect.stringContaining("status='APPROVED'"),
      [PROPOSAL, JOB],
    );
    expect(firstQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET status=?'),
      expect.arrayContaining([JOB, PROJECT, USER]),
    );

    const repeatedQuery = jest.fn().mockResolvedValueOnce([approved]);
    const repeated = serviceWithTransaction(repeatedQuery);
    await expect(repeated.approve(USER, PROJECT, JOB)).resolves.toMatchObject({
      status: 'APPROVED',
    });
    expect(repeatedQuery).toHaveBeenCalledTimes(1);
  });

  it('returns only sealed proposal fields at the public boundary', () => {
    const service = new AuthoringProposalService({} as DataSource);
    const result: PublicAuthoringProposal = service.toPublic(
      proposal('ACTIVE'),
    );
    expect(result.payload).toEqual({ title: '目录提案' });
    expect(result).not.toHaveProperty('project_id');
    expect(result).not.toHaveProperty('user_id');
    expect(result).not.toHaveProperty('resource_id');
  });

  it('stores and publishes exact raw body bytes without JSON normalization', async () => {
    const exact = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('“原文”包含 "引号"\r\n第二行：中文\n', 'utf8'),
    ]);
    const testHarness = proposalStoreHarness();

    const stored = await testHarness.service.store(claimedJob(), {
      artifactKind: 'body',
      schemaVersion: 'authoring-body.v1',
      payload: exact,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(testHarness.insertParameters?.[7]).toEqual(exact);
    expect(testHarness.insertParameters?.[7]).not.toBe(exact);
    expect(testHarness.insertParameters?.[8]).toBe(
      createHash('sha256').update(exact).digest('hex'),
    );
    expect(testHarness.insertParameters?.[9]).toBe(String(exact.byteLength));
    const publicProposal = testHarness.service.toPublic(stored);
    expect(publicProposal.payload).toBe(exact.toString('utf8'));
    expect(Buffer.from(publicProposal.payload as string, 'utf8')).toEqual(
      exact,
    );
    expect(publicProposal.payload_sha256).toBe(
      createHash('sha256').update(exact).digest('hex'),
    );
  });

  it.each(['directory', 'outline'] as const)(
    'still rejects raw non-JSON %s payloads',
    async (artifactKind) => {
      const transaction = jest.fn();
      const service = new AuthoringProposalService({
        transaction,
      } as unknown as DataSource);

      await expect(
        service.store(claimedJob(), {
          artifactKind,
          schemaVersion: `authoring-${artifactKind}.v1`,
          payload: Buffer.from('raw text\n中文', 'utf8'),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toThrow('AUTHORING_PROPOSAL_INVALID');
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('accepts exactly 4 MiB body payloads and rejects one byte more', async () => {
    const boundary = Buffer.alloc(FOUR_MIB, 0x61);
    const testHarness = proposalStoreHarness();

    await expect(
      testHarness.service.store(claimedJob(), {
        artifactKind: 'body',
        schemaVersion: 'authoring-body.v1',
        payload: boundary,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toMatchObject({ payload_utf8_bytes: String(FOUR_MIB) });

    await expect(
      testHarness.service.store(claimedJob(), {
        artifactKind: 'body',
        schemaVersion: 'authoring-body.v1',
        payload: Buffer.alloc(FOUR_MIB + 1, 0x61),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow('AUTHORING_PROPOSAL_INVALID');
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('body\u0000tail', 'utf8'),
  ])('rejects invalid raw body bytes %#', async (payload) => {
    const service = new AuthoringProposalService({
      transaction: jest.fn(),
    } as unknown as DataSource);

    await expect(
      service.store(claimedJob(), {
        artifactKind: 'body',
        schemaVersion: 'authoring-body.v1',
        payload,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow('AUTHORING_PROPOSAL_INVALID');
  });
});

function serviceWithTransaction(query: jest.Mock): AuthoringProposalService {
  const manager = { query } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn(async <T>(run: (value: EntityManager) => Promise<T>) =>
      run(manager),
    ),
  } as unknown as DataSource;
  return new AuthoringProposalService(dataSource);
}

function proposal(status: 'ACTIVE' | 'APPROVED'): AuthoringProposal {
  const now = new Date();
  return {
    id: PROPOSAL,
    job_id: JOB,
    project_id: PROJECT,
    user_id: USER,
    sequence: '1',
    artifact_kind: 'directory',
    schema_version: 'authoring-proposal.v1',
    status,
    payload: Buffer.from(JSON.stringify({ title: '目录提案' }), 'utf8'),
    payload_sha256: 'a'.repeat(64),
    payload_utf8_bytes: '24',
    expires_at: new Date(Date.now() + 60_000),
    approved_at: status === 'APPROVED' ? now : null,
    committed_at: null,
    resource_id: null,
    resource_version: null,
    created_at: now,
    updated_at: now,
  };
}

function claimedJob(): ClaimedWorkflowJob {
  return {
    id: JOB,
    userId: USER,
    projectId: PROJECT,
    workflowType: WorkflowType.CONTENT,
    input: {},
    checkpoint: null,
    leaseToken: '55555555-5555-4555-8555-555555555555',
    fencingToken: 1,
    generationAttempt: 1,
  };
}

function proposalStoreHarness(): {
  service: AuthoringProposalService;
  insertParameters: readonly unknown[] | null;
} {
  let stored: AuthoringProposal | null = null;
  const harness: {
    service: AuthoringProposalService;
    insertParameters: readonly unknown[] | null;
  } = {
    service: undefined as unknown as AuthoringProposalService,
    insertParameters: null,
  };
  const query = jest.fn(
    (sql: string, parameters: readonly unknown[] = []): unknown => {
      if (sql.includes('FROM workflow_jobs')) return [{ id: JOB }];
      if (sql.includes('WHERE p.id=?')) return stored ? [stored] : [];
      if (sql.includes('FROM authoring_proposals p')) return [];
      if (sql.includes('COALESCE(MAX(sequence),0)')) {
        return [{ maxSequence: 0 }];
      }
      if (sql.includes('INSERT INTO authoring_proposals')) {
        harness.insertParameters = parameters;
        const now = new Date();
        stored = {
          id: String(parameters[0]),
          job_id: JOB,
          project_id: PROJECT,
          user_id: USER,
          sequence: String(parameters[4]),
          artifact_kind: parameters[5] as AuthoringArtifactKind,
          schema_version: String(parameters[6]),
          status: 'ACTIVE',
          payload: parameters[7] as Buffer,
          payload_sha256: String(parameters[8]),
          payload_utf8_bytes: String(parameters[9]),
          expires_at: parameters[10] as Date,
          approved_at: null,
          committed_at: null,
          resource_id: null,
          resource_version: null,
          created_at: now,
          updated_at: now,
        };
        return { affectedRows: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  );
  const manager = { query } as unknown as EntityManager;
  const dataSource = {
    transaction: <T>(
      callback: (entityManager: EntityManager) => Promise<T>,
    ): Promise<T> => callback(manager),
  } as DataSource;
  harness.service = new AuthoringProposalService(dataSource);
  return harness;
}
