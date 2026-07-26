import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import type { ClaimSupportStatus } from '../grounding-verifier.js';
import type { PersistedAtomicClaimV1 } from '../grounding-read-policy.js';

@Entity('grounding_claims')
@Index(
  'uq_grounding_claims_result_offsets',
  ['result_id', 'output_char_start', 'output_char_end'],
  {
    unique: true,
  },
)
@Index('idx_grounding_claims_project_result', ['project_id', 'result_id'])
@Index('idx_grounding_claims_workflow', ['workflow_job_id'])
export class GroundingClaim {
  @PrimaryColumn({ type: 'char', length: 64 })
  claim_id!: string;

  @Column({ type: 'varchar', length: 36 })
  workflow_job_id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  result_id!: string;

  @Column({ type: 'text' })
  claim_text!: string;

  @Column({ type: 'text' })
  normalized_claim_text!: string;

  @Column({ type: 'int', unsigned: true })
  output_char_start!: number;

  @Column({ type: 'int', unsigned: true })
  output_char_end!: number;

  @Column({ type: 'varchar', length: 20 })
  support_status!: ClaimSupportStatus;

  @Column({ type: 'double', default: 0 })
  support_score!: number;

  @Column({ type: 'varchar', length: 50 })
  verification_method!: string;

  @Column({ type: 'json', nullable: true })
  atomic_claim!: PersistedAtomicClaimV1 | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at!: Date;
}
