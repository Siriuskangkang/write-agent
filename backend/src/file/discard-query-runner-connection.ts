import { QueryRunner } from 'typeorm';

type DestroyableConnection = {
  destroy(): void;
};

export function discardQueryRunnerConnection(queryRunner: QueryRunner): void {
  const rawConnection = (
    queryRunner as unknown as { databaseConnection?: unknown }
  ).databaseConnection;
  if (
    !rawConnection ||
    typeof (rawConnection as Partial<DestroyableConnection>).destroy !==
      'function'
  ) {
    throw new Error('QueryRunner has no destroyable database connection');
  }
  (rawConnection as DestroyableConnection).destroy();
}
