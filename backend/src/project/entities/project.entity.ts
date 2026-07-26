import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
} from 'typeorm';
import { ProjectStatus } from '../../common/enums.js';
import { ProjectState } from './project-state.entity.js';

@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  user_id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  type!: string | null;

  @Column({ type: 'text', nullable: true })
  target_audience!: string | null;

  @Column({ type: 'int', default: 10 })
  target_chapters!: number;

  @Column({ type: 'varchar', length: 50, default: '教材' })
  style!: string;

  @Column({ type: 'varchar', length: 20, default: ProjectStatus.DRAFT })
  status!: ProjectStatus;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
  })
  created_at!: Date;

  @UpdateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
  })
  updated_at!: Date;

  @OneToOne(() => ProjectState, (state) => state.project, { cascade: true })
  state?: ProjectState;
}
