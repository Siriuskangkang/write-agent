import { MODULE_METADATA } from '@nestjs/common/constants';

jest.mock('uuid', () => ({ v4: jest.fn() }));
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

import { FileModule } from './file/file.module.js';
import { ParseWorker } from './file/parse.worker.js';
import { ExportModule } from './export/export.module.js';
import { ExportWorker } from './export/export.worker.js';
import { WorkerFileModule } from './file/worker-file.module.js';
import { WorkerExportModule } from './export/worker-export.module.js';
import { WorkflowProcessor } from './workflow/workflow.processor.js';
import { WorkerWorkflowModule } from './workflow/worker-workflow.module.js';

function providersFor(module: object): unknown[] {
  const providers: unknown = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    module,
  );
  return Array.isArray(providers) ? (providers as unknown[]) : [];
}

function hasProvider(providers: unknown[], name: string): boolean {
  return providers.some(
    (provider) => typeof provider === 'function' && provider.name === name,
  );
}

describe('HTTP process worker boundary', () => {
  it('does not register Bull consumers when WORKER_MODE is not enabled', () => {
    expect(providersFor(FileModule)).not.toContain(ParseWorker);
    expect(providersFor(ExportModule)).not.toContain(ExportWorker);
  });

  it('registers Bull consumers only in the dedicated worker modules', () => {
    expect(hasProvider(providersFor(WorkerFileModule), 'ParseWorker')).toBe(
      true,
    );
    expect(hasProvider(providersFor(WorkerExportModule), 'ExportWorker')).toBe(
      true,
    );
    expect(
      hasProvider(providersFor(WorkerWorkflowModule), 'WorkflowProcessor'),
    ).toBe(true);
    expect(providersFor(FileModule)).not.toContain(WorkflowProcessor);
    expect(providersFor(ExportModule)).not.toContain(WorkflowProcessor);
  });

  it('enables worker mode for the PM2 worker process', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ecosystem = require('../../ecosystem.config.cjs') as {
      apps: Array<{ name: string; env: Record<string, string> }>;
    };
    const worker = ecosystem.apps.find(
      (application) => application.name === 'write-agent-worker',
    );

    expect(worker?.env.WORKER_MODE).toBe('true');
  });

  it('uses the Nest development launcher for the worker entrypoint', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ecosystem = require('../../ecosystem.config.cjs') as {
      apps: Array<{ name: string; script: string; args: string }>;
    };
    const worker = ecosystem.apps.find(
      (application) => application.name === 'write-agent-worker',
    );

    expect(worker?.script).toBe('node_modules/@nestjs/cli/bin/nest.js');
    expect(worker?.args).toBe('start --entryFile worker-main --watch');
  });
});
