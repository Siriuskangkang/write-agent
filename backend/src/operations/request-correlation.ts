import { randomUUID } from 'node:crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function normalizeRequestId(value: unknown): string {
  const candidate: unknown = Array.isArray(value)
    ? (value as unknown[])[0]
    : value;
  return typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate)
    ? candidate
    : randomUUID();
}

export function safeOperationalError(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return 'UnknownError';
}
