import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type StorageIntentKind =
  | 'PROMOTE'
  | 'DELETE_QUARANTINE'
  | 'DELETE_BLOB'
  | 'ABORT_PROMOTION';

export type StorageIntentStatus =
  | 'PENDING'
  | 'EXECUTING'
  | 'RETRY'
  | 'SUCCEEDED'
  | 'REJECTED';

export type StorageAuthorizationKind =
  | 'UPLOAD_COMMIT'
  | 'SOURCE_FILE_TOMBSTONE'
  | 'MOVE_ABORT';

@Entity('storage_operation_intents')
@Index('uq_storage_operation_intents_idempotency', ['idempotency_key'], {
  unique: true,
})
@Index('idx_storage_operation_intents_claim', [
  'status',
  'next_attempt_at',
  'lease_expires_at',
])
export class StorageOperationIntent {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({
    type: 'char',
    length: 64,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  idempotency_key!: string;

  @Column({
    type: 'varchar',
    length: 32,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  kind!: StorageIntentKind;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  object_id!: string;

  @Column({ type: 'bigint', unsigned: true })
  object_generation!: string;

  @Column({
    type: 'varchar',
    length: 512,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  storage_key!: string;

  @Column({
    type: 'varchar',
    length: 512,
    charset: 'ascii',
    collation: 'ascii_bin',
    nullable: true,
  })
  quarantine_key!: string | null;

  @Column({
    type: 'char',
    length: 64,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  expected_sha256!: string;

  @Column({ type: 'bigint', unsigned: true })
  expected_size!: string;

  @Column({
    type: 'varchar',
    length: 32,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  authorization_kind!: StorageAuthorizationKind;

  @Column({ type: 'varchar', length: 36 })
  authorization_id!: string;

  @Column({
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  storage_epoch!: string;

  @Column({
    type: 'varchar',
    length: 32,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  status!: StorageIntentStatus;

  @Column({ type: 'bigint', unsigned: true })
  execution_fence!: string;

  @Column({
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
    nullable: true,
  })
  lease_token!: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lease_expires_at!: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  next_attempt_at!: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  completed_at!: Date | null;

  @Column({ type: 'int', unsigned: true })
  attempts!: number;

  @Column({
    type: 'varchar',
    length: 128,
    charset: 'ascii',
    collation: 'ascii_bin',
    nullable: true,
  })
  result_code!: string | null;

  @Column({
    type: 'varchar',
    length: 128,
    charset: 'ascii',
    collation: 'ascii_bin',
    nullable: true,
  })
  last_error!: string | null;

  @Column({ type: 'datetime', precision: 6 })
  created_at!: Date;

  @Column({ type: 'datetime', precision: 6 })
  updated_at!: Date;
}
