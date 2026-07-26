import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type {
  ModelRunRequestMetadata,
  ModelRunUsage,
} from '../model-run.service.js';

@Entity('model_runs')
@Index('idx_model_runs_workflow_status', ['workflow_job_id', 'status'])
@Index(
  'uq_model_runs_job_node_attempt',
  ['workflow_job_id', 'workflow_node', 'attempt_number'],
  { unique: true },
)
@Index('uq_model_runs_operation_key', ['operation_key'], { unique: true })
export class ModelRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  workflow_job_id!: string;

  @Column({ type: 'varchar', length: 50 })
  provider!: string;

  @Column({ type: 'varchar', length: 100 })
  model!: string;

  @Column({ type: 'int', unsigned: true, default: 1 })
  attempt_number!: number;

  @Column({ type: 'varchar', length: 100, default: 'legacy' })
  workflow_node!: string;

  @Column({ type: 'varchar', length: 20, default: 'legacy' })
  attempt_kind!: string;

  @Column({ type: 'int', unsigned: true, default: 1 })
  generation_attempt!: number;

  @Column({ type: 'int', unsigned: true, default: 0 })
  network_attempt!: number;

  @Column({ type: 'int', unsigned: true, default: 0 })
  repair_attempt!: number;

  /**
   * Safe request metadata only (sampling settings, schema/trace identifiers).
   * Prompts and message text must not be stored here. `prompt_sha256` provides
   * correlation without persisting sensitive source material.
   */
  @Column({ type: 'json', nullable: true })
  request_metadata!: ModelRunRequestMetadata | null;

  @Column({ type: 'char', length: 64, nullable: true })
  prompt_sha256!: string | null;

  @Column({ type: 'char', length: 64, nullable: true })
  operation_key!: string | null;

  @Column({ type: 'char', length: 64, nullable: true })
  request_fingerprint!: string | null;

  @Column({ type: 'json', nullable: true })
  usage!: ModelRunUsage | null;

  @Column({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  cost_usd!: string | null;

  @Column({ type: 'varchar', length: 20 })
  status!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  error_code!: string | null;

  @Column({ type: 'text', nullable: true })
  error_message!: string | null;

  @Column({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  started_at!: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  completed_at!: Date | null;

  @Column({ type: 'int', unsigned: true, nullable: true })
  latency_ms!: number | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at!: Date;
}
