import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtPayload } from '../../common/guards/auth.guard.js';
import { ProjectAccessPolicy } from '../../project/project-access.policy.js';

@Injectable()
export class ProjectUploadGuard implements CanActivate {
  constructor(private readonly projectAccessPolicy: ProjectAccessPolicy) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user: JwtPayload }>();
    await this.projectAccessPolicy.assertOwner(
      request.user.sub,
      String(request.params['id']),
    );
    return true;
  }
}
