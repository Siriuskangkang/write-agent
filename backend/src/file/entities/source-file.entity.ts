import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { FileType, ParseStatus } from '../../common/enums.js';
import { Document } from './document.entity.js';

@Entity('source_files')
export class SourceFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 500 })
  file_name!: string;

  @Column({ type: 'varchar', length: 20 })
  file_type!: FileType;

  @Column({ type: 'bigint', nullable: true })
  file_size!: number | null;

  @Column({ type: 'varchar', length: 1000 })
  file_path!: string;

  @Column({ type: 'char', length: 64, nullable: true })
  checksum_sha256!: string | null;

  @Column({ type: 'char', length: 64, nullable: true })
  active_ingestion_key!: string | null;

  @Column({ type: 'int', default: 1 })
  parse_generation!: number;

  @Column({ type: 'char', length: 36, nullable: true })
  parse_attempt_token!: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  parse_lease_expires_at!: Date | null;

  @Column({ type: 'varchar', length: 20, default: ParseStatus.PENDING })
  parse_status!: ParseStatus;

  @Column({ type: 'text', nullable: true })
  error_message!: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  deleted_at!: Date | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  deleted_by!: string | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
  })
  uploaded_at!: Date;

  @OneToMany(() => Document, (doc) => doc.source_file)
  documents!: Document[];
}
