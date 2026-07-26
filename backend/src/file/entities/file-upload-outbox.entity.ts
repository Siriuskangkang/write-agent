import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('file_upload_outbox')
export class FileUploadOutbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36, unique: true })
  file_id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'int', default: 1 })
  parse_generation!: number;

  @Column({ type: 'varchar', length: 36, nullable: true })
  storage_intent_id!: string | null;

  @Column({ type: 'varchar', length: 100, unique: true })
  job_id!: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: 'storage_preparing' | 'storage_pending' | 'pending' | 'published';

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lease_owner!: string | null;

  @Column({ type: 'timestamp', precision: 6, nullable: true })
  lease_expires_at!: Date | null;

  @Column({
    type: 'timestamp',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  next_attempt_at!: Date;

  @CreateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
  })
  created_at!: Date;
}
