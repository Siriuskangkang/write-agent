import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { RetrievalState } from '../../retrieval/types.js';

export type GroundingContractVersion = 'atomic:v1' | 'legacy:v0';

@Entity('grounding_assignments')
@Index('idx_grounding_assignments_run', ['retrieval_run_id'])
@Index('idx_grounding_assignments_project', ['project_id'])
export class GroundingAssignment {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  workflow_job_id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  retrieval_run_id!: string;

  @Column({ type: 'varchar', length: 20 })
  retrieval_state!: RetrievalState;

  @Column({ type: 'json' })
  retrieval_run_refs!: string[];

  @Column({ type: 'json' })
  evidence_ids!: string[];

  @Column({ type: 'char', length: 64, nullable: true })
  snapshot_digest!: string | null;

  @Column({ type: 'boolean', default: true })
  strict_mode!: boolean;

  @Column({ type: 'int', unsigned: true, default: 0 })
  targeted_revision_attempts!: number;

  @Column({ type: 'varchar', length: 32, default: 'legacy:v0' })
  contract_version!: GroundingContractVersion;

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
