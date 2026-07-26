import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('content_versions')
export class ContentVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  result_id!: string;

  @Column({ type: 'int' })
  version_number!: number;

  @Column({ type: 'varchar', length: 20, default: 'ai' })
  editor_source!: string;

  @Column({ type: 'text' })
  content_text!: string;

  @Column({ type: 'boolean', default: false })
  is_current!: boolean;

  @CreateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
  })
  created_at!: Date;
}
