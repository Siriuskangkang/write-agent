import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { DeterministicAuthoringGraph } from '../authoring/graph/deterministic-authoring.graph.js';
import { StorageModule } from '../storage/storage.module.js';
import { WorkerWorkflowModule } from './worker-workflow.module.js';

jest.mock('../content/content.module.js', () => ({
  ContentModule: class ContentModule {},
}));

describe('WorkerWorkflowModule deterministic authoring wiring', () => {
  it('registers the graph provider and storage readiness module', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      WorkerWorkflowModule,
    ) as unknown[];
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      WorkerWorkflowModule,
    ) as unknown[];

    expect(providers).toContain(DeterministicAuthoringGraph);
    expect(imports).toContain(StorageModule);
  });
});
