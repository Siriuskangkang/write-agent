import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '../guards/auth.guard.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest<{ user: JwtPayload }>();
    return request.user;
  },
);
