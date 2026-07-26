import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { normalizeRequestId } from './request-correlation.js';

@Injectable()
export class RequestCorrelationMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestCorrelationMiddleware.name);

  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = normalizeRequestId(request.headers['x-request-id']);
    request.headers['x-request-id'] = requestId;
    response.setHeader('X-Request-Id', requestId);
    const startedAt = Date.now();
    response.once('finish', () => {
      this.logger.log(
        JSON.stringify({
          event: 'http_request',
          request_id: requestId,
          method: request.method,
          route: request.path,
          status_code: response.statusCode,
          duration_ms: Date.now() - startedAt,
        }),
      );
    });
    next();
  }
}
