import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const report = join(
  tmpdir(),
  `atomic-grounding-e2e-${process.pid}-${randomUUID()}.json`,
);
const jest = new URL('../node_modules/jest/bin/jest.js', import.meta.url);
let exitCode = 1;

try {
  const result = spawnSync(
    process.execPath,
    [
      jest.pathname,
      '--config',
      './test/jest-e2e.json',
      'atomic-grounding-shadow.e2e-spec.ts',
      '--runInBand',
      '--json',
      `--outputFile=${report}`,
    ],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: process.env,
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  } else {
    const summary = JSON.parse(readFileSync(report, 'utf8'));
    const exact =
      summary.success === true &&
      summary.numTotalTests === 6 &&
      summary.numPassedTests === 6 &&
      summary.numPendingTests === 0 &&
      summary.numFailedTests === 0;
    if (!exact) {
      process.stderr.write(
        `atomic grounding E2E count gate failed: ${JSON.stringify({
          success: summary.success,
          numTotalTests: summary.numTotalTests,
          numPassedTests: summary.numPassedTests,
          numPendingTests: summary.numPendingTests,
          numFailedTests: summary.numFailedTests,
        })}\n`,
      );
    } else {
      process.stdout.write(
        'atomic grounding E2E count gate: 6 passed, 0 skipped, 0 failed\n',
      );
      exitCode = 0;
    }
    process.exitCode = exact ? 0 : 1;
  }
} finally {
  try {
    unlinkSync(report);
  } catch {
    // Delete only this invocation's unique report when it exists.
  }
}

if (process.exitCode === undefined) process.exitCode = exitCode;
