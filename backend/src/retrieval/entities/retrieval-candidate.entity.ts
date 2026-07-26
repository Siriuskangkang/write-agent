import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { EvidenceItem } from '../types.js';

@Entity('retrieval_candidates')
@Index('uq_retrieval_candidates_run_chunk', ['retrieval_run_id', 'chunk_id'], {
  unique: true,
})
@Index('idx_retrieval_candidates_run_fusion', [
  'retrieval_run_id',
  'fusion_rank',
])
export class RetrievalCandidateRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  retrieval_run_id!: string;

  @Column({ type: 'varchar', length: 36 })
  chunk_id!: string;

  @Column({ type: 'varchar', length: 36 })
  file_id!: string;

  @Column({ type: 'varchar', length: 36 })
  document_id!: string;

  @Column({ type: 'char', length: 64, nullable: true })
  ingestion_key!: string | null;

  @Column({ type: 'int', nullable: true })
  sparse_rank!: number | null;

  @Column({ type: 'double', nullable: true })
  sparse_score!: number | null;

  @Column({ type: 'int', nullable: true })
  dense_rank!: number | null;

  @Column({ type: 'double', nullable: true })
  dense_score!: number | null;

  @Column({ type: 'int' })
  fusion_rank!: number;

  @Column({ type: 'double' })
  fusion_score!: number;

  @Column({ type: 'int' })
  rerank_rank!: number;

  @Column({ type: 'double' })
  rerank_score!: number;

  @Column({ type: 'boolean', default: false })
  selected!: boolean;

  @Column({ type: 'json', nullable: true })
  evidence!: EvidenceItem | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at!: Date;
}
