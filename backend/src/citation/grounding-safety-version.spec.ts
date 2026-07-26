import { MINIMUM_SAFE_GROUNDING_BINARY } from './grounding-safety-version.js';

describe('grounding rollback safety floor', () => {
  it('announces the fail-closed legacy read capability', () => {
    expect(MINIMUM_SAFE_GROUNDING_BINARY).toBe(
      'legacy-grounding-fail-closed.v1',
    );
  });
});
