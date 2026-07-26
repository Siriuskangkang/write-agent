import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { TaskType, WritingResultStatus } from '../../common/enums.js';

@Entity('writing_results')
export class WritingResult {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  session_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  chapter_node_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  section_node_id!: string | null;

  @Column({ type: 'int', nullable: true })
  chapter_index!: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  chapter_title!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  section_title!: string | null;

  @Column({ type: 'varchar', length: 30 })
  task_type!: TaskType;

  @Column({
    type: 'varchar',
    length: 20,
    default: WritingResultStatus.STREAMING,
  })
  status!: WritingResultStatus;

  @Column({ type: 'text' })
  content_text!: string;

  @Column({ type: 'int', nullable: true })
  word_count!: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  style!: string | null;

  @Column({ type: 'int', default: 1 })
  version_number!: number;

  @Column({ type: 'varchar', length: 36, nullable: true })
  parent_result_id!: string | null;

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
