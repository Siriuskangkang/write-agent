import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Project } from '../../project/entities/project.entity.js';

export interface StyleTreeNode {
  id?: string;
  title: string;
  children: StyleTreeNode[];
  requirement?: string;
}

export interface PanelAssignment {
  panel_a: StyleTreeNode[];
  panel_b: StyleTreeNode[];
  panel_c?: StyleTreeNode[];
}

export interface StyleFeatures {
  structure_tree: StyleTreeNode;
  panel_assignment?: PanelAssignment;
}

@Entity('style_templates')
export class StyleTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 36, name: 'project_id' })
  projectId: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @Column({ type: 'varchar', length: 1024, name: 'file_path', nullable: true })
  filePath: string | null;

  @Column({ type: 'json', name: 'reference_file_ids', nullable: true })
  referenceFileIds: string[] | null;

  @Column({ type: 'json', nullable: true })
  features: StyleFeatures | null;

  @Column({
    type: 'enum',
    enum: ['pending', 'analyzing', 'completed', 'failed'],
    default: 'pending',
  })
  status: 'pending' | 'analyzing' | 'completed' | 'failed';

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  errorMessage: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
  })
  updatedAt: Date;
}
