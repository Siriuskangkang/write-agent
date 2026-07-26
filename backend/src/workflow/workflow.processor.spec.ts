import * as Bull from 'bull';
import { WorkflowProcessor } from './workflow.processor.js';
import type { WorkflowEngine } from './workflow.engine.js';

describe('WorkflowProcessor', () => {
  it('treats Bull delivery as a trigger and executes by durable job id', async () => {
    const engine: Pick<WorkflowEngine, 'run'> = {
      run: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new WorkflowProcessor(engine as WorkflowEngine);

    await processor.handle({
      data: { jobId: '11111111-1111-4111-8111-111111111111' },
    } as Bull.Job<{ jobId: string }>);

    expect(engine.run).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
    );
  });
});
