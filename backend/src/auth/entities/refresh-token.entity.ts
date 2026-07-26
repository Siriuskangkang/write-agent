import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('refresh_tokens')
@Index('idx_refresh_tokens_user_id', ['user_id'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  user_id!: string;

  @Column({ type: 'varchar', length: 255 })
  token_hash!: string;

  @Column({ type: 'datetime' })
  expires_at!: Date;

  @Column({ type: 'datetime', nullable: true })
  revoked_at!: Date | null;

  @CreateDateColumn({
    type: 'datetime',
    precision: 0,
    default: () => 'CURRENT_TIMESTAMP',
  })
  created_at!: Date;
}
