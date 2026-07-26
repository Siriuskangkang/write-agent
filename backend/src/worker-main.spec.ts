import './worker.test-environment.js';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import { bootstrapWorker } from './worker-main.js';

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

describe('worker-main bootstrap', () => {
  it('creates an application context and exposes only its worker metrics exporter', async () => {
    const exporter = {};
    const applicationContext = {
      close: jest.fn(),
      get: jest.fn().mockReturnValue(exporter),
    };
    const createApplicationContext = jest
      .spyOn(NestFactory, 'createApplicationContext')
      .mockResolvedValue(applicationContext as never);
    const createHttp = jest.spyOn(NestFactory, 'create');

    const startMetricsServer = jest.fn().mockResolvedValue(undefined);
    await bootstrapWorker({ startMetricsServer });

    expect(createApplicationContext).toHaveBeenCalledWith(WorkerModule);
    expect(createHttp).not.toHaveBeenCalled();
    expect(applicationContext.get).toHaveBeenCalled();
    expect(startMetricsServer).toHaveBeenCalledWith(
      exporter,
      9465,
      '127.0.0.1',
    );
  });
});
