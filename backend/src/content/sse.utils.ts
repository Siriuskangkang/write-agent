import * as express from 'express';
import type Redis from 'ioredis';

/**
 * 幂等检查：尝试用 SET NX EX 锁定 requestId
 * 返回 true 表示是重复请求（key 已存在），应返回 409
 * 返回 false 表示首次请求，正常处理
 */
export async function checkSseDuplicate(
  redis: Redis,
  requestId: string | undefined,
): Promise<boolean> {
  if (!requestId) return false;
  const result = await redis.set(
    `sse:request:${requestId}`,
    '1',
    'EX',
    300,
    'NX',
  );
  return result === null;
}

export function writeSseEvent(
  res: express.Response,
  eventType: string,
  data: any,
) {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  const flush = (res as express.Response & { flush?: () => void }).flush;
  flush?.call(res);
}

export function initSse(res: express.Response): () => void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const timer = setInterval(() => {
    writeSseEvent(res, 'heartbeat', { type: 'heartbeat' });
  }, 15000);

  return () => clearInterval(timer);
}
