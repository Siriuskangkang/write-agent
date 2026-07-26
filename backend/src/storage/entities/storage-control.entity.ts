import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('storage_control')
export class StorageControl {
  @PrimaryColumn({ type: 'tinyint', unsigned: true })
  singleton_id!: number;

  @Column({
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  active_epoch!: string;

  @Column({
    type: 'varchar',
    length: 64,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  broker_contract_version!: 'storage-broker.v1';

  @Column({ type: 'datetime', precision: 6 })
  activated_at!: Date;
}
