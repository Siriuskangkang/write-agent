import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { OperationsService } from './operations.service.js';

@Controller('health')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const readiness = await this.operations.readiness();
    if (readiness.status !== 'ready') response.status(503);
    return readiness;
  }

  @Get('metrics')
  metrics(): Promise<Record<string, unknown>> {
    return this.operations.metrics();
  }
}
