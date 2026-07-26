import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { SourceFile } from './source-file.entity.js';
import type { DocumentAst } from '../parsers/document-ast.js';

@Entity('documents')
@Index('uq_documents_file_ingestion', ['file_id', 'ingestion_key'], {
  unique: true,
})
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  file_id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  title!: string | null;

  @Column({ type: 'mediumtext', nullable: true })
  content_text!: string | null;

  @Column({ type: 'int', nullable: true })
  page_count!: number | null;

  @Column({ type: 'json', nullable: true })
  sections!: Array<{ title: string; content: string; page?: number }>;

  @Column({ type: 'char', length: 64 })
  source_checksum!: string;

  @Column({ type: 'varchar', length: 50 })
  parser_version!: string;

  @Column({ type: 'varchar', length: 50 })
  chunk_version!: string;

  @Column({ type: 'char', length: 64 })
  ingestion_key!: string;

  @Column({ type: 'json' })
  ast!: DocumentAst;

  @Column({ type: 'boolean', default: false })
  is_active!: boolean;

  @CreateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
  })
  parsed_at!: Date;

  @ManyToOne(() => SourceFile, (sf) => sf.documents, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'file_id' })
  source_file!: SourceFile;
}
