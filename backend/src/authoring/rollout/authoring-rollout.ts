import { createHash } from 'node:crypto';
import { canonicalJsonV1 } from '../../citation/atomic-grounding/canonical-json.js';

export const AUTHORING_POLICY_VERSION =
  'deterministic-authoring-rollout.v1' as const;
export const AUTHORING_CLIENT_CONTRACT = 'authoring-approval-ui.v1' as const;

export type AuthoringMode = 'off' | 'shadow' | 'enforce_allowlist';
export type WorkflowDefinition =
  | 'legacy-generation.v1'
  | 'atomic-shadow.v1'
  | 'deterministic-authoring-shadow.v1'
  | 'deterministic-authoring.v1';
export type ServerEntrypoint = 'legacy_api' | 'workflow_api' | 'internal';

export interface AuthoringRolloutConfig {
  mode: AuthoringMode;
  allowlist: ReadonlySet<string>;
  policyVersion: string;
}

export interface AuthoringPolicySnapshotV1 {
  allowlisted: boolean;
  authoring_mode: AuthoringMode;
  client_contract_version: typeof AUTHORING_CLIENT_CONTRACT | null;
  policy_version: string;
  server_entrypoint: ServerEntrypoint;
  workflow_definition: WorkflowDefinition;
}

export interface AuthoringPolicySelection {
  workflowDefinition: WorkflowDefinition;
  authoringMode: AuthoringMode;
  rolloutPolicyVersion: string;
  snapshot: AuthoringPolicySnapshotV1;
  snapshotDigest: string;
  serverEntrypoint: ServerEntrypoint;
  clientContractVersion: typeof AUTHORING_CLIENT_CONTRACT | null;
}

const LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseAuthoringRolloutConfig(
  source: Record<string, unknown>,
): AuthoringRolloutConfig {
  const rawMode = source.AUTHORING_COMMIT_MODE ?? source.AUTHORING_MODE;
  const requestedMode: AuthoringMode =
    rawMode === 'shadow' || rawMode === 'enforce_allowlist' ? rawMode : 'off';
  const rawAllowlist =
    source.AUTHORING_ALLOWLIST_PROJECT_IDS ?? source.AUTHORING_ALLOWLIST;
  const values =
    typeof rawAllowlist === 'string' && rawAllowlist.length > 0
      ? rawAllowlist.split(',')
      : [];
  if (values.some((value) => !LOWERCASE_UUID.test(value))) {
    return {
      mode: 'off',
      allowlist: new Set(),
      policyVersion: AUTHORING_POLICY_VERSION,
    };
  }
  const policyVersion =
    typeof source.AUTHORING_ROLLOUT_POLICY_VERSION === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(source.AUTHORING_ROLLOUT_POLICY_VERSION)
      ? source.AUTHORING_ROLLOUT_POLICY_VERSION
      : AUTHORING_POLICY_VERSION;
  return {
    mode: requestedMode,
    allowlist: new Set(values),
    policyVersion,
  };
}

export function selectAuthoringPolicy(input: {
  projectId: string;
  serverEntrypoint: ServerEntrypoint;
  clientContractVersion?: typeof AUTHORING_CLIENT_CONTRACT;
  config: AuthoringRolloutConfig;
}): AuthoringPolicySelection {
  const clientContractVersion = input.clientContractVersion ?? null;
  const allowlisted = input.config.allowlist.has(input.projectId);
  let authoringMode: AuthoringMode = 'off';
  let workflowDefinition: WorkflowDefinition = 'legacy-generation.v1';

  if (input.serverEntrypoint === 'workflow_api') {
    if (input.config.mode === 'shadow') {
      authoringMode = 'shadow';
      workflowDefinition =
        clientContractVersion === AUTHORING_CLIENT_CONTRACT
          ? 'deterministic-authoring-shadow.v1'
          : 'atomic-shadow.v1';
    } else if (input.config.mode === 'enforce_allowlist') {
      if (allowlisted && clientContractVersion === AUTHORING_CLIENT_CONTRACT) {
        authoringMode = 'enforce_allowlist';
        workflowDefinition = 'deterministic-authoring.v1';
      }
    }
  }

  const snapshot: AuthoringPolicySnapshotV1 = {
    allowlisted,
    authoring_mode: authoringMode,
    client_contract_version: clientContractVersion,
    policy_version: input.config.policyVersion,
    server_entrypoint: input.serverEntrypoint,
    workflow_definition: workflowDefinition,
  };
  return {
    workflowDefinition,
    authoringMode,
    rolloutPolicyVersion: input.config.policyVersion,
    snapshot,
    snapshotDigest: authoringPolicySnapshotDigest(snapshot),
    serverEntrypoint: input.serverEntrypoint,
    clientContractVersion,
  };
}

export function authoringPolicySnapshotDigest(
  snapshot: AuthoringPolicySnapshotV1,
): string {
  return createHash('sha256').update(canonicalJsonV1(snapshot)).digest('hex');
}

export function restoreAuthoringPolicySelection(value: {
  workflowDefinition: WorkflowDefinition;
  authoringMode: AuthoringMode;
  rolloutPolicyVersion: string;
  snapshot: AuthoringPolicySnapshotV1;
  snapshotDigest: string;
  serverEntrypoint: ServerEntrypoint;
  clientContractVersion: typeof AUTHORING_CLIENT_CONTRACT | null;
}): AuthoringPolicySelection {
  let expected: string;
  try {
    expected = authoringPolicySnapshotDigest(value.snapshot);
  } catch {
    throw new Error('AUTHORING_POLICY_SNAPSHOT_INVALID');
  }
  if (
    typeof value.snapshot.allowlisted !== 'boolean' ||
    !isAuthoringMode(value.snapshot.authoring_mode) ||
    !isWorkflowDefinition(value.snapshot.workflow_definition) ||
    !isServerEntrypoint(value.snapshot.server_entrypoint) ||
    (value.snapshot.client_contract_version !== null &&
      value.snapshot.client_contract_version !== AUTHORING_CLIENT_CONTRACT) ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.snapshot.policy_version) ||
    expected !== value.snapshotDigest ||
    value.snapshot.workflow_definition !== value.workflowDefinition ||
    value.snapshot.authoring_mode !== value.authoringMode ||
    value.snapshot.policy_version !== value.rolloutPolicyVersion ||
    value.snapshot.server_entrypoint !== value.serverEntrypoint ||
    value.snapshot.client_contract_version !== value.clientContractVersion
  ) {
    throw new Error('AUTHORING_POLICY_SNAPSHOT_INVALID');
  }
  return { ...value };
}

function isAuthoringMode(value: unknown): value is AuthoringMode {
  return value === 'off' || value === 'shadow' || value === 'enforce_allowlist';
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    value === 'legacy-generation.v1' ||
    value === 'atomic-shadow.v1' ||
    value === 'deterministic-authoring-shadow.v1' ||
    value === 'deterministic-authoring.v1'
  );
}

function isServerEntrypoint(value: unknown): value is ServerEntrypoint {
  return (
    value === 'legacy_api' || value === 'workflow_api' || value === 'internal'
  );
}
