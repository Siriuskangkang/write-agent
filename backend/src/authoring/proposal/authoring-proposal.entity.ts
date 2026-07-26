import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AuthoringArtifactKind = 'directory' | 'outline' | 'body';
export type AuthoringProposalStatus =
  | 'ACTIVE'
  | 'APPROVED'
  | 'COMMITTED'
  | 'EXPIRED'
  | 'INVALIDATED';

@Entity('authoring_proposals')
@Index('uq_authoring_proposals_job_sequence', ['job_id', 'sequence'], {
  unique: true,
})
@Index('uq_authoring_proposals_job_active', ['job_id', 'active_slot'], {
  unique: true,
})
@Index('idx_authoring_proposals_owner', [
  'user_id',
  'project_id',
  'job_id',
  'status',
])
export class AuthoringProposal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  job_id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  user_id!: string;

  @Column({ type: 'bigint', unsigned: true })
  sequence!: string;

  @Column({ type: 'varchar', length: 32 })
  artifact_kind!: AuthoringArtifactKind;

  @Column({ type: 'varchar', length: 64 })
  schema_version!: string;

  @Column({ type: 'varchar', length: 32 })
  status!: AuthoringProposalStatus;

  @Column({ type: 'longblob' })
  payload!: Buffer;

  @Column({ type: 'char', length: 64 })
  payload_sha256!: string;

  @Column({ type: 'bigint', unsigned: true })
  payload_utf8_bytes!: string;

  @Column({ type: 'datetime', precision: 6 })
  expires_at!: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  approved_at!: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  committed_at!: Date | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  resource_id!: string | null;

  @Column({ type: 'bigint', unsigned: true, nullable: true })
  resource_version!: string | null;

  @Column({
    type: 'tinyint',
    nullable: true,
    asExpression:
      "CASE WHEN status IN ('ACTIVE','APPROVED') THEN 1 ELSE NULL END",
    generatedType: 'STORED',
    select: false,
    insert: false,
    update: false,
  })
  active_slot?: number | null;

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
