import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('retrieval_index_versions')
@Index('idx_retrieval_index_project_status', ['project_id', 'status'])
@Index('idx_retrieval_index_dispatch', [
  'status',
  'next_retry_at',
  'lease_expires_at',
])
@Index('idx_retrieval_index_retention_debt', [
  'retention_debt_recorded_at',
  'status',
])
@Index(
  'uq_retrieval_index_file_ingestion_version',
  ['file_id', 'ingestion_key', 'index_version'],
  { unique: true },
)
export class RetrievalIndexVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  file_id!: string;

  @Column({ type: 'varchar', length: 36 })
  document_id!: string;

  @Column({ type: 'char', length: 64 })
  ingestion_key!: string;

  @Column({ type: 'varchar', length: 50 })
  chunk_version!: string;

  @Column({ type: 'varchar', length: 50 })
  index_version!: string;

  @Column({ type: 'varchar', length: 50, default: 'qdrant' })
  provider!: string;

  @Column({ type: 'varchar', length: 100, default: 'write_agent_chunks' })
  collection_name!: string;

  @Column({ type: 'varchar', length: 100 })
  embedding_model!: string;

  @Column({ type: 'int' })
  embedding_dimension!: number;

  @Column({ type: 'varchar', length: 20, default: 'Cosine' })
  distance!: string;

  @Column({ type: 'varchar', length: 20, default: 'ngram' })
  sparse_parser!: string;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status!: 'PENDING' | 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED';

  @Column({ type: 'char', length: 36, nullable: true })
  claim_token!: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lease_expires_at!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempt_count!: number;

  @Column({ type: 'int', default: 5 })
  max_attempts!: number;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  next_retry_at!: Date | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  published_namespace!: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  retention_debt_recorded_at!: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  retention_debt_reason!: string | null;

  @Column({ type: 'int', default: 0 })
  point_count!: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  error_code!: string | null;

  @Column({ type: 'text', nullable: true })
  error_message!: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  indexed_at!: Date | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at!: Date;

  @UpdateDateColumn({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
    onUpdate: 'CURRENT_TIMESTAMP(6)',
  })
  updated_at!: Date;
}
