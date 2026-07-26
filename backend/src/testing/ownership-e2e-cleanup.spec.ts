import { cleanupOwnershipE2e } from './ownership-e2e-cleanup.js';

describe('cleanupOwnershipE2e', () => {
  it('continues with schema drop and connection close when app close fails', async () => {
    const app = { close: jest.fn().mockRejectedValue(new Error('app close')) };
    const connection = {
      query: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      cleanupOwnershipE2e({
        app,
        connection,
        schemaName: 'write_agent_auth_e2e_cleanup',
        schemaCreated: true,
      }),
    ).rejects.toThrow('app close');
    expect(connection.query).toHaveBeenCalledWith(
      'DROP DATABASE IF EXISTS `write_agent_auth_e2e_cleanup`',
    );
    expect(connection.end).toHaveBeenCalled();
  });

  it('does not drop an uncreated or invalid schema but still ends the connection', async () => {
    const connection = {
      query: jest.fn(),
      end: jest.fn().mockResolvedValue(undefined),
    };

    await cleanupOwnershipE2e({
      connection,
      schemaName: 'textweaver',
      schemaCreated: false,
    });

    expect(connection.query).not.toHaveBeenCalled();
    expect(connection.end).toHaveBeenCalled();
  });
});
