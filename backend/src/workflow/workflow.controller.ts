import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  Optional,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ok } from '../common/dto/response.dto.js';
import { JwtAuthGuard, type JwtPayload } from '../common/guards/auth.guard.js';
import { CreateWorkflowDto } from './dto/create-workflow.dto.js';
import { ListWorkflowEventsQueryDto } from './dto/list-workflow-events-query.dto.js';
import { WorkflowService } from './workflow.service.js';
import type * as express from 'express';
import { WorkflowDispatchService } from './workflow-dispatch.service.js';
import { WorkflowEventStreamService } from './workflow-event-stream.service.js';
import { AuthoringProposalService } from '../authoring/proposal/authoring-proposal.service.js';

@ApiTags('Workflows')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/workflows')
export class WorkflowController {
  constructor(
    private readonly workflowService: WorkflowService,
    @Optional()
    private readonly dispatchService?: WorkflowDispatchService,
    @Optional()
    private readonly eventStream?: WorkflowEventStreamService,
    @Optional()
    private readonly proposalService?: AuthoringProposalService,
  ) {}

  @Post()
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateWorkflowDto,
  ) {
    const job = this.dispatchService
      ? await this.dispatchService.createAndDispatch(user.sub, projectId, dto)
      : await this.workflowService.create(user.sub, projectId, dto);
    return ok(this.workflowService.toPublicJob(job));
  }

  @Get(':jobId/proposal')
  async findProposal(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    if (!this.proposalService) {
      throw new ServiceUnavailableException('作者提案服务不可用');
    }
    const proposal = await this.proposalService.findActive(
      user.sub,
      projectId,
      jobId,
    );
    return ok(this.proposalService.toPublic(proposal));
  }

  @Get(':jobId')
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    const job = await this.workflowService.findOne(user.sub, projectId, jobId);
    return ok(this.workflowService.toPublicJob(job));
  }

  @Get(':jobId/events')
  async listEvents(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Query() query: ListWorkflowEventsQueryDto,
    @Headers('last-event-id') lastEventId?: string,
    @Headers('accept') accept?: string,
    @Req() request?: express.Request,
    @Res() response?: express.Response,
  ) {
    if (
      accept?.toLowerCase().includes('text/event-stream') &&
      this.eventStream &&
      request &&
      response
    ) {
      await this.eventStream.stream(
        user.sub,
        projectId,
        jobId,
        query,
        lastEventId,
        request,
        response,
      );
      return;
    }
    const result = ok(
      await this.workflowService.listEvents(
        user.sub,
        projectId,
        jobId,
        query,
        lastEventId,
      ),
    );
    if (response) {
      response.status(HttpStatus.OK).json(result);
      return;
    }
    return result;
  }

  @Post(':jobId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    const job = await this.workflowService.cancel(user.sub, projectId, jobId);
    return ok(this.workflowService.toPublicJob(job));
  }

  @Post(':jobId/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    if (!this.proposalService) {
      throw new ServiceUnavailableException('作者提案服务不可用');
    }
    await this.proposalService.approve(user.sub, projectId, jobId);
    if (this.dispatchService) {
      await this.dispatchService.dispatch(jobId);
    }
    const job = await this.workflowService.findOne(user.sub, projectId, jobId);
    return ok(this.workflowService.toPublicJob(job));
  }

  @Post(':jobId/resume')
  @HttpCode(HttpStatus.OK)
  async resumeMaterial(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    const job = await this.workflowService.resumeMaterial(
      user.sub,
      projectId,
      jobId,
    );
    if (this.dispatchService) {
      await this.dispatchService.dispatch(job.id);
    }
    return ok(this.workflowService.toPublicJob(job));
  }
}
