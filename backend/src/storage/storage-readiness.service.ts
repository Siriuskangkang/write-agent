import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { findStorageAuthorityContractViolations } from '../../migrations/support/storage-schema-contract.js';
import {
  parseStorageAuthorityConfig,
  type StorageAuthorityConfig,
} from './storage.config.js';

export interface StorageAuthoritySnapshotV1 {
  storage_epoch: string;
  storage_contract_version: 'storage-broker.v1';
}

@Injectable()
export class StorageReadinessService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async assertReady(): Promise<StorageAuthoritySnapshotV1> {
    let config: StorageAuthorityConfig;
    try {
      config = parseStorageAuthorityConfig({
        STORAGE_AUTHORITY_MODE: this.configService.get(
          'STORAGE_AUTHORITY_MODE',
        ),
        STORAGE_PROTECTED_ROOT: this.configService.get(
          'STORAGE_PROTECTED_ROOT',
        ),
        STORAGE_QUARANTINE_ROOT: this.configService.get(
          'STORAGE_QUARANTINE_ROOT',
        ),
      });
    } catch {
      return authorityUnproven();
    }
    if (config.mode !== 'broker') return authorityUnproven();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      const violations =
        await findStorageAuthorityContractViolations(queryRunner);
      if (violations.length > 0) return authorityUnproven();
      const rows: unknown = await queryRunner.query(
        `SELECT active_epoch AS storage_epoch,
                broker_contract_version AS storage_contract_version
           FROM storage_control
          WHERE singleton_id=1`,
      );
      if (!Array.isArray(rows) || rows.length !== 1) {
        return authorityUnproven();
      }
      const row = rows[0] as Record<string, unknown>;
      if (
        typeof row.storage_epoch !== 'string' ||
        row.storage_contract_version !== 'storage-broker.v1'
      ) {
        return authorityUnproven();
      }
      return {
        storage_epoch: row.storage_epoch,
        storage_contract_version: 'storage-broker.v1',
      };
    } finally {
      await queryRunner.release();
    }
  }
}

function authorityUnproven(): never {
  throw new Error('STORAGE_AUTHORITY_UNPROVEN');
}
