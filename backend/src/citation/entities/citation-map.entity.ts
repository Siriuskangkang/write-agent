import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { CitationUseType } from '../../common/enums.js';
import type { ClaimSupportStatus } from '../grounding-verifier.js';

@Entity('citation_maps')
export class CitationMap {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  result_id!: string;

  @Column({ type: 'varchar', length: 200 })
  paragraph_key!: string;

  @Column({ type: 'varchar', length: 36 })
  chunk_id!: string;

  @Column({ type: 'varchar', length: 36 })
  file_id!: string;

  @Column({ type: 'varchar', length: 30 })
  use_type!: CitationUseType;

  @Column('text')
  evidence_text!: string;

  @Column({ type: 'int', nullable: true })
  page_number!: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  section_title!: string | null;

  @Column({ type: 'float', default: 0 })
  confidence_score!: number;

  @Column({ type: 'char', length: 64, nullable: true })
  claim_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  evidence_id!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  document_id!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  retrieval_run_id!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'UNVERIFIABLE' })
  support_status!: ClaimSupportStatus;

  @Column({ type: 'double', default: 0 })
  support_score!: number;

  @Column({ type: 'varchar', length: 50, default: 'legacy_unverifiable' })
  verification_method!: string;

  @Column({ type: 'int', nullable: true })
  evidence_char_start!: number | null;

  @Column({ type: 'int', nullable: true })
  evidence_char_end!: number | null;

  @Column({ type: 'int', nullable: true })
  chunk_char_start!: number | null;

  @Column({ type: 'int', nullable: true })
  chunk_char_end!: number | null;

  @Column({ type: 'int', nullable: true })
  candidate_rank!: number | null;

  @Column({ type: 'int', nullable: true })
  sparse_rank!: number | null;

  @Column({ type: 'int', nullable: true })
  dense_rank!: number | null;

  @Column({ type: 'int', nullable: true })
  fusion_rank!: number | null;

  @Column({ type: 'int', nullable: true })
  rerank_rank!: number | null;

  @Column({ type: 'double', nullable: true })
  sparse_score!: number | null;

  @Column({ type: 'double', nullable: true })
  dense_score!: number | null;

  @Column({ type: 'double', nullable: true })
  fusion_score!: number | null;

  @Column({ type: 'double', nullable: true })
  rerank_score!: number | null;

  @Column({ type: 'char', length: 64, nullable: true })
  ingestion_key!: string | null;

  @Column({ type: 'json', nullable: true })
  index_snapshot!: Record<string, unknown> | null;

  @Column({ type: 'char', length: 64, nullable: true })
  snapshot_digest!: string | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
  })
  created_at!: Date;
}
