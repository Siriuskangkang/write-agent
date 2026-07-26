import { describe, expect, it } from 'vitest';
import { shouldClientSaveDirectory } from './legacyWorkflowAdapter';

describe('legacy workflow adapter', () => {
  it('does not save a directory that the durable workflow already committed', () => {
    expect(
      shouldClientSaveDirectory({
        serverSaved: true,
        directoryId: 'directory-version-1',
        workflowJobId: 'workflow-job-1',
      }),
    ).toBe(false);
  });

  it('keeps the old client-save fallback for direct legacy streams', () => {
    expect(shouldClientSaveDirectory({ serverSaved: false })).toBe(true);
  });
});
