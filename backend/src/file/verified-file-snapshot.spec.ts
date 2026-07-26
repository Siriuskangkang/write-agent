import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readVerifiedFileSnapshot,
  readVerifiedFileSnapshotFromHandle,
} from './verified-file-snapshot.js';

describe('readVerifiedFileSnapshot', () => {
  let fixtureDir: string;

  beforeEach(async () => {
    fixtureDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'write-agent-snapshot-'),
    );
  });

  afterEach(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('hashes and returns the exact bytes read from one open descriptor', async () => {
    const filePath = path.join(fixtureDir, 'material.md');
    const bytes = Buffer.from('# 已验证内容');
    await fs.writeFile(filePath, bytes);
    const checksum = createHash('sha256').update(bytes).digest('hex');

    await expect(
      readVerifiedFileSnapshot(filePath, {
        expected_checksum: checksum,
        max_bytes: 1024,
      }),
    ).resolves.toEqual({ bytes, checksum, size: bytes.length });
  });

  it('rejects mismatched upload identity and oversized source bytes', async () => {
    const filePath = path.join(fixtureDir, 'material.md');
    await fs.writeFile(filePath, 'changed bytes');

    await expect(
      readVerifiedFileSnapshot(filePath, {
        expected_checksum: 'a'.repeat(64),
        max_bytes: 1024,
      }),
    ).rejects.toThrow('Source file checksum changed after upload');
    await expect(
      readVerifiedFileSnapshot(filePath, {
        expected_checksum: null,
        max_bytes: 2,
      }),
    ).rejects.toThrow('Parser budget exceeded: bytes');
  });

  it('detects in-place mutation between descriptor stats', async () => {
    const before = {
      size: 4,
      mtimeNs: 10n,
      ctimeNs: 10n,
      ino: 7n,
      isFile: () => true,
    };
    const handle = {
      stat: jest
        .fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce({ ...before, mtimeNs: 11n }),
      read: jest
        .fn()
        .mockImplementation(
          (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
          ) => {
            Buffer.from('test').copy(
              buffer,
              offset,
              position,
              position + length,
            );
            return Promise.resolve({
              bytesRead: Math.max(0, Math.min(length, 4 - position)),
              buffer,
            });
          },
        ),
    };

    await expect(
      readVerifiedFileSnapshotFromHandle(handle as never, {
        expected_checksum: null,
        max_bytes: 1024,
      }),
    ).rejects.toThrow('Source file changed while parsing snapshot');
  });

  it('stops a growing descriptor after reading at most max_bytes plus one', async () => {
    const requestedLengths: number[] = [];
    let emitted = 0;
    const handle = {
      stat: jest.fn().mockResolvedValue({
        size: 512n,
        mtimeNs: 10n,
        ctimeNs: 10n,
        ino: 7n,
        isFile: () => true,
      }),
      read: jest
        .fn()
        .mockImplementation(
          (buffer: Buffer, offset: number, length: number) => {
            requestedLengths.push(length);
            const bytesRead = Math.min(length, 700);
            buffer.fill(0x61, offset, offset + bytesRead);
            emitted += bytesRead;
            return Promise.resolve({ bytesRead, buffer });
          },
        ),
    };

    await expect(
      readVerifiedFileSnapshotFromHandle(handle as never, {
        expected_checksum: null,
        max_bytes: 1024,
      }),
    ).rejects.toThrow('Source file changed while parsing snapshot');

    expect(emitted).toBe(513);
    expect(requestedLengths).toEqual([513]);
    expect(handle.read).toHaveBeenCalledTimes(1);
    expect(Math.max(...requestedLengths)).toBeLessThanOrEqual(513);
    expect(handle.stat).toHaveBeenCalledTimes(2);
  });
});
