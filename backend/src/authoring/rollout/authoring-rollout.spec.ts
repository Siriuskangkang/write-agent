import {
  AUTHORING_CLIENT_CONTRACT,
  parseAuthoringRolloutConfig,
  restoreAuthoringPolicySelection,
  selectAuthoringPolicy,
} from './authoring-rollout.js';

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('deterministic authoring rollout selector', () => {
  it('is safe-off for unknown configuration and malformed allowlists', () => {
    expect(
      parseAuthoringRolloutConfig({
        AUTHORING_MODE: 'enforce_allowlist',
        AUTHORING_ALLOWLIST: PROJECT.toUpperCase(),
      }),
    ).toMatchObject({ mode: 'off' });
  });

  it('selects enforce only for workflow API, approval UI, and allowlist', () => {
    const config = parseAuthoringRolloutConfig({
      AUTHORING_MODE: 'enforce_allowlist',
      AUTHORING_ALLOWLIST: PROJECT,
    });
    const selected = selectAuthoringPolicy({
      projectId: PROJECT,
      serverEntrypoint: 'workflow_api',
      clientContractVersion: AUTHORING_CLIENT_CONTRACT,
      config,
    });

    expect(selected).toMatchObject({
      workflowDefinition: 'deterministic-authoring.v1',
      authoringMode: 'enforce_allowlist',
    });
    expect(restoreAuthoringPolicySelection(selected)).toEqual(selected);
  });

  it('prefers canonical environment names while retaining legacy aliases', () => {
    const canonical = parseAuthoringRolloutConfig({
      AUTHORING_COMMIT_MODE: 'enforce_allowlist',
      AUTHORING_ALLOWLIST_PROJECT_IDS: PROJECT,
      AUTHORING_MODE: 'off',
      AUTHORING_ALLOWLIST: '',
    });
    expect(canonical.mode).toBe('enforce_allowlist');
    expect(canonical.allowlist.has(PROJECT)).toBe(true);

    const legacy = parseAuthoringRolloutConfig({
      AUTHORING_MODE: 'shadow',
      AUTHORING_ALLOWLIST: PROJECT,
    });
    expect(legacy.mode).toBe('shadow');
    expect(legacy.allowlist.has(PROJECT)).toBe(true);
  });

  it('keeps legacy API and non-allowlisted enforce calls out of approval', () => {
    const config = parseAuthoringRolloutConfig({
      AUTHORING_MODE: 'enforce_allowlist',
      AUTHORING_ALLOWLIST: PROJECT,
    });
    expect(
      selectAuthoringPolicy({
        projectId: PROJECT,
        serverEntrypoint: 'legacy_api',
        clientContractVersion: AUTHORING_CLIENT_CONTRACT,
        config,
      }).workflowDefinition,
    ).toBe('legacy-generation.v1');
    expect(
      selectAuthoringPolicy({
        projectId: '22222222-2222-4222-8222-222222222222',
        serverEntrypoint: 'workflow_api',
        clientContractVersion: AUTHORING_CLIENT_CONTRACT,
        config,
      }).workflowDefinition,
    ).toBe('legacy-generation.v1');
  });

  it('rejects a restored snapshot whose digest or persisted fields drift', () => {
    const selected = selectAuthoringPolicy({
      projectId: PROJECT,
      serverEntrypoint: 'workflow_api',
      config: parseAuthoringRolloutConfig({
        AUTHORING_MODE: 'shadow',
        AUTHORING_ALLOWLIST: '',
      }),
    });
    expect(selected.workflowDefinition).toBe('atomic-shadow.v1');
    expect(() =>
      restoreAuthoringPolicySelection({
        ...selected,
        snapshotDigest: '0'.repeat(64),
      }),
    ).toThrow('AUTHORING_POLICY_SNAPSHOT_INVALID');
  });
});
