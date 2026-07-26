import './worker.test-environment.js';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import { bootstrapWorker } from './worker.js';

jest.mock('./file/parse.worker.js', () => ({
  ParseWorker: class ParseWorker {},
}));
jest.mock('./export/export.worker.js', () => ({
  ExportWorker: class ExportWorker {},
}));
jest.mock('./workflow/workflow.processor.js', () => ({
  WORKFLOW_QUEUE: 'workflow',
  WORKFLOW_RUN_JOB: 'run',
  WorkflowProcessor: class WorkflowProcessor {},
}));
jest.mock('./content/content.module.js', () => ({
  ContentModule: class ContentModule {},
}));

describe('worker bootstrap', () => {
  it('boots the dedicated worker module without an HTTP server', async () => {
    const applicationContext = {
      close: jest.fn(),
      get: jest.fn().mockReturnValue({}),
    };
    const createApplicationContext = jest
      .spyOn(NestFactory, 'createApplicationContext')
      .mockResolvedValue(applicationContext as never);

    await bootstrapWorker({
      startMetricsServer: jest.fn().mockResolvedValue(undefined),
    });

    expect(createApplicationContext).toHaveBeenCalledWith(WorkerModule);
  });
});
