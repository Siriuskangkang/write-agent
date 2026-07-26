import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { ExportFormat, ExportScope } from '../../common/enums.js';

@Entity('export_jobs')
export class ExportJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 20 })
  format!: ExportFormat;

  @Column({ type: 'varchar', length: 20 })
  scope!: ExportScope;

  @Column({ type: 'json', nullable: true })
  chapter_ids!: string[] | null;

  @Column({ type: 'boolean', default: true })
  include_citations!: boolean;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: 'pending' | 'processing' | 'completed' | 'failed';

  @Column({ type: 'varchar', length: 1000, nullable: true })
  file_path!: string | null;

  @Column({ type: 'text', nullable: true })
  error_message!: string | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
  })
  created_at!: Date;

  @Column({ type: 'datetime', nullable: true })
  completed_at!: Date | null;
}
