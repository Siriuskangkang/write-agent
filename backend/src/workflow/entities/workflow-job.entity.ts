import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WorkflowStatus, WorkflowType } from '../workflow.types.js';
import type {
  AuthoringMode,
  AuthoringPolicySnapshotV1,
  ServerEntrypoint,
  WorkflowDefinition,
} from '../../authoring/rollout/authoring-rollout.js';

@Entity('workflow_jobs')
@Index(
  'uq_workflow_jobs_idempotency',
  ['user_id', 'project_id', 'workflow_type', 'idempotency_key'],
  { unique: true },
)
@Index('idx_workflow_jobs_project_status_created', [
  'project_id',
  'status',
  'created_at',
])
@Index('idx_workflow_jobs_status_lease', ['status', 'lease_expires_at'])
export class WorkflowJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  user_id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 50 })
  workflow_type!: WorkflowType;

  /**
   * Always non-null. The API generates a UUID when callers omit this value,
   * so only an explicitly reused key deduplicates requests.
   */
  @Column({ type: 'varchar', length: 128 })
  idempotency_key!: string;

  @Column({ type: 'char', length: 64 })
  request_hash!: string;

  @Column({ type: 'varchar', length: 32, default: WorkflowStatus.QUEUED })
  status!: WorkflowStatus;

  @Column({ type: 'json', nullable: true })
  input!: Record<string, unknown> | null;

  @Column({ type: 'json', nullable: true })
  checkpoint!: Record<string, unknown> | null;

  @Column({
    type: 'varchar',
    length: 64,
    default: 'legacy-generation.v1',
  })
  workflow_definition?: WorkflowDefinition;

  @Column({ type: 'varchar', length: 32, default: 'off' })
  authoring_mode?: AuthoringMode;

  @Column({
    type: 'varchar',
    length: 64,
    default: 'deterministic-authoring-rollout.v1',
  })
  rollout_policy_version?: string;

  @Column({ type: 'json' })
  rollout_policy_snapshot?: AuthoringPolicySnapshotV1;

  @Column({ type: 'char', length: 64 })
  rollout_policy_digest?: string;

  @Column({ type: 'varchar', length: 32, default: 'internal' })
  server_entrypoint?: ServerEntrypoint;

  @Column({ type: 'varchar', length: 64, nullable: true })
  client_contract_version?: 'authoring-approval-ui.v1' | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  lease_owner?: string | null;

  @Column({ type: 'char', length: 36, nullable: true })
  lease_token?: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lease_expires_at?: Date | null;

  @Column({ type: 'bigint', unsigned: true, default: 0 })
  fencing_token?: string;

  @Column({ type: 'int', unsigned: true, default: 0 })
  attempt_count?: number;

  @Column({ type: 'int', unsigned: true, default: 0 })
  generation_attempt?: number;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  cancel_requested_at!: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  approved_at!: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  error_code!: string | null;

  @Column({ type: 'text', nullable: true })
  error_message!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  public_error_code!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  public_error_message!: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  started_at!: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  completed_at!: Date | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at!: Date;

  @UpdateDateColumn({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
    onUpdate: 'CURRENT_TIMESTAMP(6)',
  })
  updated_at!: Date;
}
