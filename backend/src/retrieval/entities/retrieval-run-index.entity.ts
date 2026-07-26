import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('retrieval_run_index_versions')
@Index('uq_retrieval_run_index_file', ['retrieval_run_id', 'file_id'], {
  unique: true,
})
export class RetrievalRunIndexVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  retrieval_run_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  index_version_id!: string | null;

  @Column({ type: 'varchar', length: 36 })
  file_id!: string;

  @Column({ type: 'char', length: 64 })
  ingestion_key!: string;

  @Column({ type: 'varchar', length: 50 })
  index_version!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: string;

  @Column({ type: 'int', default: 0 })
  expected_point_count!: number;

  @Column({ type: 'int', nullable: true })
  observed_point_count!: number | null;
}
