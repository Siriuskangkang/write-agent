import type { MigrationInterface, QueryRunner } from 'typeorm';
import { findStorageAuthorityContractViolations } from './support/storage-schema-contract';
import { createHash } from 'node:crypto';

const APP_ROLE = 'wa_app_role_v1';
const REQUEST_ROUTINES = [
  'sp_storage_request_promote_v1',
  'sp_storage_request_delete_quarantine_v1',
  'sp_storage_request_delete_blob_v1',
  'sp_storage_request_abort_promotion_v1',
] as const;
const LEGACY_REQUEST_DDL_SHA256: Readonly<Record<string, string>> = {
  sp_storage_request_abort_promotion_v1:
    '534069eae45cf89d93d9f3cb0a1f0d962ea10ba447b74e53d5092fac4c714df4',
  sp_storage_request_delete_blob_v1:
    'd83d29887e3c49bf3207e3f6a1aac5db6151dd67a00a505fc5d831819508364d',
  sp_storage_request_delete_quarantine_v1:
    '8a916511bbcc3172a08edf3599ea23ba1803b424807bed362f3bea798ba480da',
  sp_storage_request_promote_v1:
    '43fad644f313cef501b2da9171ada80480062489536df2d47ba9e2b535f02b8d',
};

export class MakeStorageRequestsTransactionBound1713430000000 implements MigrationInterface {
  name = 'MakeStorageRequestsTransactionBound1713430000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const violations = await findStorageAuthorityContractViolations(
      queryRunner,
      {
        requestRoutines: 'legacy',
      },
    );
    if (violations.length > 0) {
      throw new Error(
        `STORAGE_AUTHORITY_RECONCILIATION_REQUIRED:${violations[0]}`,
      );
    }

    const database = await currentDatabase(queryRunner);
    const definitions = new Map<string, string>();
    for (const routine of REQUEST_ROUTINES) {
      const rows: unknown = await queryRunner.query(
        `SHOW CREATE PROCEDURE \`${routine}\``,
      );
      if (!Array.isArray(rows) || rows.length !== 1) {
        throw new Error(`STORAGE_REQUEST_ROUTINE_INVALID:${routine}`);
      }
      const definition = (rows[0] as Record<string, unknown>)[
        'Create Procedure'
      ];
      if (typeof definition !== 'string') {
        throw new Error(`STORAGE_REQUEST_ROUTINE_INVALID:${routine}`);
      }
      if (
        authoritySqlDigest(definition, database) !==
        LEGACY_REQUEST_DDL_SHA256[routine]
      ) {
        throw new Error(`STORAGE_REQUEST_ROUTINE_INVALID:${routine}`);
      }
      definitions.set(
        routine,
        makeTransactionBoundRequestDefinition(definition),
      );
    }

    for (const routine of REQUEST_ROUTINES) {
      await queryRunner.query(`DROP PROCEDURE \`${routine}\``);
      await queryRunner.query(definitions.get(routine)!);
      await queryRunner.query(
        `GRANT EXECUTE ON PROCEDURE ${quoteIdentifier(database)}.\`${routine}\`
           TO '${APP_ROLE}'`,
      );
    }

    for (const routine of REQUEST_ROUTINES) {
      const rows: unknown = await queryRunner.query(
        `SHOW CREATE PROCEDURE \`${routine}\``,
      );
      const definition =
        Array.isArray(rows) && rows.length === 1
          ? (rows[0] as Record<string, unknown>)['Create Procedure']
          : null;
      if (
        typeof definition !== 'string' ||
        containsOwnedTransaction(definition)
      ) {
        throw new Error(`STORAGE_REQUEST_ROUTINE_INVALID:${routine}`);
      }
    }
    const reconciled =
      await findStorageAuthorityContractViolations(queryRunner);
    if (reconciled.length > 0) {
      throw new Error(
        `STORAGE_AUTHORITY_RECONCILIATION_REQUIRED:${reconciled[0]}`,
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<never> {
    throw new Error('STORAGE_AUTHORITY_DESTRUCTIVE_ROLLBACK_FORBIDDEN');
  }
}

function makeTransactionBoundRequestDefinition(definition: string): string {
  const handler =
    /\s*DECLARE EXIT HANDLER FOR SQLEXCEPTION\s+BEGIN\s+ROLLBACK;\s+RESIGNAL;\s+END;\s*/gi;
  const start = /\s*START TRANSACTION;\s*/gi;
  const commit = /\s*COMMIT;\s*/gi;
  if (
    matchCount(definition, handler) !== 1 ||
    matchCount(definition, start) !== 1 ||
    matchCount(definition, commit) !== 2
  ) {
    throw new Error('STORAGE_REQUEST_ROUTINE_INVALID');
  }
  const transactionBound = definition
    .replace(handler, '\n')
    .replace(start, '\n')
    .replace(commit, '\n');
  if (containsOwnedTransaction(transactionBound)) {
    throw new Error('STORAGE_REQUEST_ROUTINE_INVALID');
  }
  return transactionBound;
}

function containsOwnedTransaction(definition: string): boolean {
  return (
    /\bSTART\s+TRANSACTION\b/i.test(definition) ||
    /\bCOMMIT\s*;/i.test(definition) ||
    /\bROLLBACK\s*;/i.test(definition) ||
    /\bDECLARE\s+EXIT\s+HANDLER\s+FOR\s+SQLEXCEPTION\b/i.test(definition)
  );
}

function matchCount(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

async function currentDatabase(queryRunner: QueryRunner): Promise<string> {
  const rows: unknown = await queryRunner.query(
    'SELECT DATABASE() AS databaseName',
  );
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof (rows[0] as Record<string, unknown>).databaseName !== 'string'
  ) {
    throw new Error('STORAGE_AUTHORITY_DATABASE_UNKNOWN');
  }
  return String((rows[0] as Record<string, unknown>).databaseName);
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``;
}

function authoritySqlDigest(value: string, database: string): string {
  return createHash('sha256')
    .update(
      value
        .replaceAll('`', '')
        .replace(/_(?:utf8mb4|ascii)/gi, '')
        .replaceAll("\\'", "'")
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/definer=[^ ]+/, 'definer=<definer>')
        .replaceAll(`${database.toLowerCase()}.`, '<schema>.'),
    )
    .digest('hex');
}
