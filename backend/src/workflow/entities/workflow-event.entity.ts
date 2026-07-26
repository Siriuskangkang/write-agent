import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('workflow_events')
@Index('uq_workflow_events_job_seq', ['job_id', 'seq'], { unique: true })
export class WorkflowEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  job_id!: string;

  @Column({ type: 'int', unsigned: true })
  seq!: number;

  @Column({ type: 'varchar', length: 100 })
  type!: string;

  @Column({ type: 'json', nullable: true })
  data!: Record<string, unknown> | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at!: Date;
}
