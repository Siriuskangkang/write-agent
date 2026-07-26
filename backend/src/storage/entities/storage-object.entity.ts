import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type StorageObjectState =
  | 'STAGING'
  | 'AVAILABLE'
  | 'DELETE_PENDING'
  | 'DELETED';

@Entity('storage_objects')
@Index('uq_storage_objects_key', ['storage_key'], { unique: true })
@Index('uq_storage_objects_file_generation', ['source_file_id', 'generation'], {
  unique: true,
})
@Index(
  'uq_storage_objects_intent_identity',
  ['id', 'project_id', 'generation', 'storage_key'],
  { unique: true },
)
export class StorageObject {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  source_file_id!: string;

  @Column({ type: 'bigint', unsigned: true })
  generation!: string;

  @Column({
    type: 'varchar',
    length: 512,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  storage_key!: string;

  @Column({
    type: 'char',
    length: 64,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  checksum_sha256!: string;

  @Column({ type: 'bigint', unsigned: true })
  byte_size!: string;

  @Column({
    type: 'varchar',
    length: 32,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  state!: StorageObjectState;

  @Column({ type: 'datetime', precision: 6 })
  created_at!: Date;

  @Column({ type: 'datetime', precision: 6 })
  updated_at!: Date;
}
