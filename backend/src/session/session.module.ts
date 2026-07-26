import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from './entities/session.entity.js';
import { Message } from './entities/message.entity.js';
import { SessionService } from './session.service.js';
import { SessionController } from './session.controller.js';
import { ProjectModule } from '../project/project.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Session, Message]),
    ProjectModule,
    AuthModule,
  ],
  controllers: [SessionController],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
