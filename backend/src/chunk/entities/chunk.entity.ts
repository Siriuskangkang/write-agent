import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('chunks')
@Index('uq_chunks_document_stable_key', ['document_id', 'stable_key'], {
  unique: true,
})
export class Chunk {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  file_id!: string;

  @Column({ type: 'varchar', length: 36 })
  document_id!: string;

  @Column('int')
  chunk_index!: number;

  @Column('longtext')
  content!: string;

  @Column({ type: 'longtext' })
  search_text!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  section_title!: string | null;

  @Column({ type: 'int', nullable: true })
  page_number!: number | null;

  @Column({ type: 'json', nullable: true })
  keywords!: string[];

  @Column({ type: 'json', nullable: true })
  search_terms!: string[];

  @Column({ type: 'char', length: 64, nullable: true })
  stable_key!: string | null;

  @Column({ type: 'char', length: 64, nullable: true })
  ingestion_key!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'child' })
  chunk_type!: 'parent' | 'child';

  @Column({ type: 'varchar', length: 36, nullable: true })
  parent_id!: string | null;

  @Column({ type: 'int', default: 0 })
  position!: number;

  @Column({ type: 'int', default: 0 })
  token_count!: number;

  @Column({ type: 'varchar', length: 50, default: 'legacy-char-v1' })
  tokenizer_version!: string;

  @Column({ type: 'int', default: 0 })
  overlap_previous_tokens!: number;

  @Column({ type: 'json', nullable: true })
  heading_path!: string[] | null;

  @Column({ type: 'int', nullable: true })
  page_start!: number | null;

  @Column({ type: 'int', nullable: true })
  page_end!: number | null;

  @Column({ type: 'json', nullable: true })
  block_ids!: string[] | null;

  @Column({ type: 'int', nullable: true })
  char_start!: number | null;

  @Column({ type: 'int', nullable: true })
  char_end!: number | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @CreateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
  })
  created_at!: Date;
}
