import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import type { OutlineContentDto } from '../dto/save-outline.dto.js';

@Entity('outline_versions')
export class OutlineVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 100 })
  chapter_node_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  section_node_id!: string | null;

  @Column({ type: 'int' })
  chapter_index!: number;

  @Column({ type: 'varchar', length: 500 })
  chapter_title!: string;

  @Column({ type: 'int' })
  version_number!: number;

  @Column({ type: 'json' })
  content!: OutlineContentDto;

  @Column({ type: 'boolean', default: false })
  is_current!: boolean;

  @CreateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
  })
  created_at!: Date;
}
