import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('file_move_intents')
export class FileMoveIntent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20, default: 'ACTIVE' })
  status!: 'ACTIVE' | 'REJECTED' | 'UNCERTAIN';

  @Column({ type: 'varchar', length: 1000 })
  source_path!: string;

  @Column({ type: 'varchar', length: 1000 })
  destination_path!: string;

  @Column({ type: 'varchar', length: 36, unique: true })
  file_id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  user_id!: string;

  @Column({ type: 'bigint' })
  file_size!: number;

  @Column({ type: 'varchar', length: 100 })
  writer_token!: string;

  @Column({ type: 'timestamp', precision: 6 })
  recover_after!: Date;

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
