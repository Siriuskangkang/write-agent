import type * as Bull from 'bull';
import type { WorkflowService } from './workflow.service.js';
import { WorkflowDispatchService } from './workflow-dispatch.service.js';
import { WorkflowStatus, WorkflowType } from './workflow.types.js';

describe('WorkflowDispatchService', () => {
  it('returns the durable MySQL job even when Redis delivery does not acknowledge', async () => {
    const durableJob = {
      id: '11111111-1111-4111-8111-111111111111',
      status: WorkflowStatus.QUEUED,
      workflow_type: WorkflowType.CONTENT,
    };
    const workflowService = {
      create: jest.fn().mockResolvedValue(durableJob),
    };
    const queue = {
      add: jest.fn().mockReturnValue(new Promise(() => undefined)),
    };
    const dispatch = new WorkflowDispatchService(
      workflowService as unknown as WorkflowService,
      queue as unknown as Bull.Queue<{ jobId: string }>,
      { acknowledgementTimeoutMs: 5 },
    );

    const result = await Promise.race([
      dispatch.createAndDispatch('user-1', 'project-1', {
        workflow_type: WorkflowType.CONTENT,
      }),
      new Promise<'timed-out'>((resolve) =>
        setTimeout(() => resolve('timed-out'), 50),
      ),
    ]);

    expect(result).toBe(durableJob);
    expect(queue.add).toHaveBeenCalledWith(
      'run',
      { jobId: durableJob.id },
      expect.objectContaining({ jobId: durableJob.id }),
    );
  });

  it('retires a hung acknowledgement so recovery can create a new delivery attempt', async () => {
    const workflowService = { create: jest.fn() };
    const queue = {
      add: jest.fn().mockReturnValue(new Promise(() => undefined)),
    };
    const dispatch = new WorkflowDispatchService(
      workflowService as unknown as WorkflowService,
      queue as unknown as Bull.Queue<{ jobId: string }>,
      { acknowledgementTimeoutMs: 2 },
    );

    await dispatch.dispatch('11111111-1111-4111-8111-111111111111');
    await dispatch.dispatch('11111111-1111-4111-8111-111111111111');

    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('ignores a late settlement from a timed-out attempt without clearing the replacement', async () => {
    let resolveFirst!: (value: Bull.Job<{ jobId: string }>) => void;
    const first = new Promise<Bull.Job<{ jobId: string }>>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Bull.Job<{ jobId: string }>>(() => undefined);
    const queue = {
      add: jest.fn().mockReturnValueOnce(first).mockReturnValue(second),
    };
    const dispatch = new WorkflowDispatchService(
      { create: jest.fn() } as unknown as WorkflowService,
      queue as unknown as Bull.Queue<{ jobId: string }>,
      { acknowledgementTimeoutMs: 2 },
    );
    const jobId = '11111111-1111-4111-8111-111111111111';

    await dispatch.dispatch(jobId);
    const replacement = dispatch.dispatch(jobId);
    resolveFirst({} as Bull.Job<{ jobId: string }>);
    await replacement;
    await dispatch.dispatch(jobId);

    expect(queue.add).toHaveBeenCalledTimes(3);
  });
});
