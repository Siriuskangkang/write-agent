export interface OwnershipE2eApp {
  close(): Promise<void>;
}

export interface OwnershipE2eConnection {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export async function cleanupOwnershipE2e({
  app,
  connection,
  schemaName,
  schemaCreated,
}: {
  app?: OwnershipE2eApp;
  connection?: OwnershipE2eConnection;
  schemaName: string;
  schemaCreated: boolean;
}): Promise<void> {
  const errors: unknown[] = [];

  if (app) {
    try {
      await app.close();
    } catch (error) {
      errors.push(error);
    }
  }

  if (
    connection &&
    schemaCreated &&
    schemaName.startsWith('write_agent_auth_e2e_')
  ) {
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${schemaName}\``);
    } catch (error) {
      errors.push(error);
    }
  }

  if (connection) {
    try {
      await connection.end();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    const messages = errors.map((error) => String(error)).join('; ');
    throw new AggregateError(
      errors,
      `Ownership e2e cleanup failed: ${messages}`,
    );
  }
}
