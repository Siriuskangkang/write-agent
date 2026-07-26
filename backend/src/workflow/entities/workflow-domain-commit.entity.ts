import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('workflow_domain_commits')
@Index('idx_workflow_domain_commits_resource', ['workflow_type', 'resource_id'])
export class WorkflowDomainCommit {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  workflow_job_id!: string;

  @Column({ type: 'varchar', length: 50 })
  workflow_type!: string;

  @Column({ type: 'varchar', length: 36 })
  resource_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  version_id!: string | null;

  @Column({ type: 'bigint', unsigned: true })
  fencing_token!: string;

  @Column({ type: 'json', nullable: true })
  commit_payload!: Record<string, unknown> | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at!: Date;
}
