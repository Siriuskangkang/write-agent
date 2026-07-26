import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type {
  RetrievalQueryPlan,
  RetrievalState,
  RetrievalTaskType,
} from '../types.js';

@Entity('retrieval_runs')
@Index('idx_retrieval_runs_project_created', ['project_id', 'created_at'])
@Index(
  'uq_retrieval_runs_workflow_revision',
  ['workflow_job_id', 'revision_attempt'],
  { unique: true },
)
export class RetrievalRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  workflow_job_id!: string | null;

  @Column({ type: 'tinyint', unsigned: true, nullable: true })
  revision_attempt!: number | null;

  @Column({ type: 'char', length: 64, nullable: true })
  request_sha256!: string | null;

  @Column({ type: 'varchar', length: 500 })
  query!: string;

  @Column({ type: 'varchar', length: 20 })
  task_type!: RetrievalTaskType;

  @Column({ type: 'json' })
  query_plan!: RetrievalQueryPlan;

  @Column({ type: 'varchar', length: 20, default: 'RUNNING' })
  state!: RetrievalState | 'RUNNING';

  @Column({ type: 'varchar', length: 20, default: 'shadow' })
  mode!: 'legacy' | 'shadow' | 'hybrid';

  @Column({ type: 'boolean', default: false })
  gate_decision!: boolean;

  @Column({ type: 'varchar', length: 30, default: 'legacy_like' })
  canonical_path!: 'hybrid' | 'legacy_like';

  @Column({ type: 'varchar', length: 30, nullable: true })
  shadow_path!: 'hybrid' | 'legacy_like' | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  canonical_state!: RetrievalState | null;

  @Column({ type: 'int', nullable: true })
  canonical_latency_ms!: number | null;

  @Column({ type: 'int', default: 0 })
  canonical_count!: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  canonical_error_code!: string | null;

  @Column({ type: 'text', nullable: true })
  canonical_error_message!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  shadow_state!: RetrievalState | null;

  @Column({ type: 'int', nullable: true })
  shadow_latency_ms!: number | null;

  @Column({ type: 'int', default: 0 })
  shadow_count!: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  shadow_error_code!: string | null;

  @Column({ type: 'text', nullable: true })
  shadow_error_message!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  error_code!: string | null;

  @Column({ type: 'text', nullable: true })
  error_message!: string | null;

  @Column({ type: 'int', default: 0 })
  sparse_count!: number;

  @Column({ type: 'int', default: 0 })
  dense_count!: number;

  @Column({ type: 'int', default: 0 })
  fused_count!: number;

  @Column({ type: 'int', default: 0 })
  legacy_count!: number;

  @Column({ type: 'int', default: 0 })
  selected_count!: number;

  @Column({ type: 'int', nullable: true })
  latency_ms!: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 8, nullable: true })
  embedding_cost_usd!: string | null;

  @Column({ type: 'int', nullable: true })
  embedding_input_tokens!: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 8, nullable: true })
  embedding_estimated_cost_usd!: string | null;

  @Column({ type: 'int', nullable: true })
  embedding_estimated_input_tokens!: number | null;

  @Column({ type: 'boolean', default: false })
  embedding_usage_estimated!: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  collection_name!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  embedding_model!: string | null;

  @Column({ type: 'int', nullable: true })
  embedding_dimension!: number | null;

  @Column({ type: 'char', length: 64, nullable: true })
  retrieval_config_hash!: string | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at!: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  completed_at!: Date | null;
}
