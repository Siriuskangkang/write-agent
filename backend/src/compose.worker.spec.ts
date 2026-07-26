import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '..', '..');

describe('Compose worker service', () => {
  it('runs a dedicated queue consumer with the API shared storage', () => {
    const rendered = execFileSync(
      'docker',
      ['compose', '--profile', 'app', 'config', '--format', 'json'],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const compose = JSON.parse(rendered) as {
      services: Record<
        string,
        {
          command?: string[];
          environment?: Record<string, string>;
          depends_on?: Record<string, { condition: string }>;
          volumes?: Array<{ target: string }>;
        }
      >;
    };

    const worker = compose.services.worker;
    const backend = compose.services.backend;

    expect(worker.command).toEqual(['node', 'dist/worker-main.js']);
    expect(worker.environment?.WORKER_MODE).toBe('true');
    expect(worker.environment?.QDRANT_URL).toBe('http://qdrant:6333');
    expect(backend.environment?.QDRANT_URL).toBe('http://qdrant:6333');
    expect(worker.depends_on?.qdrant?.condition).toBe('service_healthy');
    expect(backend.depends_on?.qdrant?.condition).toBe('service_healthy');
    expect(worker.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: '/app/uploads' }),
      ]),
    );
    expect(backend.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: '/app/uploads' }),
      ]),
    );
  });
});
