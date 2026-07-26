import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Project } from './project.entity.js';

@Entity('project_states')
export class ProjectState {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36, unique: true })
  project_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  current_directory_version_id!: string | null;

  @Column({ type: 'json' })
  completed_chapters!: any[];

  @Column({ type: 'varchar', length: 255, nullable: true })
  in_progress_chapter!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  in_progress_section!: string | null;

  @Column({ type: 'json' })
  pending_items!: any[];

  @Column({ type: 'json' })
  material_gaps!: any[];

  @Column({ type: 'text', nullable: true })
  user_notes!: string | null;

  @UpdateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
  })
  updated_at!: Date;

  @OneToOne(() => Project, (project) => project.state, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
