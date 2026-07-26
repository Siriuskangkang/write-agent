import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { parseStorageAuthorityConfig } from './storage.config.js';
import { StorageReadinessService } from './storage-readiness.service.js';

describe('storage authority configuration', () => {
  it.each([undefined, '', 'BROKER', ' broker ', 'unknown'])(
    'resolves %p to legacy',
    (value) => {
      expect(
        parseStorageAuthorityConfig({ STORAGE_AUTHORITY_MODE: value }),
      ).toEqual({
        mode: 'legacy',
        protectedRoot: null,
        quarantineRoot: null,
      });
    },
  );

  it.each([
    {
      STORAGE_AUTHORITY_MODE: 'broker',
      STORAGE_PROTECTED_ROOT: 'uploads',
      STORAGE_QUARANTINE_ROOT: '/var/db/textweaver/quarantine',
    },
    {
      STORAGE_AUTHORITY_MODE: 'broker',
      STORAGE_PROTECTED_ROOT: '/var/db/textweaver/storage/',
      STORAGE_QUARANTINE_ROOT: '/var/db/textweaver/quarantine',
    },
    {
      STORAGE_AUTHORITY_MODE: 'broker',
      STORAGE_PROTECTED_ROOT: '/var/db/textweaver/storage',
      STORAGE_QUARANTINE_ROOT: '/var/db/textweaver/storage',
    },
  ])('rejects invalid broker roots %#', (config) => {
    expect(() => parseStorageAuthorityConfig(config)).toThrow(
      'STORAGE_ROOTS_INVALID',
    );
  });

  it('accepts absolute normalized distinct roots in broker mode', () => {
    expect(
      parseStorageAuthorityConfig({
        STORAGE_AUTHORITY_MODE: 'broker',
        STORAGE_PROTECTED_ROOT: '/var/db/textweaver/storage',
        STORAGE_QUARANTINE_ROOT: '/var/db/textweaver/quarantine',
      }),
    ).toEqual({
      mode: 'broker',
      protectedRoot: '/var/db/textweaver/storage',
      quarantineRoot: '/var/db/textweaver/quarantine',
    });
  });

  it('fails legacy readiness without querying storage control', async () => {
    const query = jest.fn();
    const dataSource = { query } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string) =>
        key === 'STORAGE_AUTHORITY_MODE' ? 'legacy' : undefined,
      ),
    } as unknown as ConfigService;
    const readiness = new StorageReadinessService(dataSource, config);

    await expect(readiness.assertReady()).rejects.toThrow(
      'STORAGE_AUTHORITY_UNPROVEN',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('maps invalid broker roots to unproven readiness without a query', async () => {
    const createQueryRunner = jest.fn();
    const dataSource = { createQueryRunner } as unknown as DataSource;
    const values: Record<string, string> = {
      STORAGE_AUTHORITY_MODE: 'broker',
      STORAGE_PROTECTED_ROOT: 'uploads',
      STORAGE_QUARANTINE_ROOT: '/var/db/textweaver/quarantine',
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    const readiness = new StorageReadinessService(dataSource, config);

    await expect(readiness.assertReady()).rejects.toThrow(
      'STORAGE_AUTHORITY_UNPROVEN',
    );
    expect(createQueryRunner).not.toHaveBeenCalled();
  });
});
