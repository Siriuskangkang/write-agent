import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthoringCommitService } from './commit/authoring-commit.service.js';
import { AuthoringProposal } from './proposal/authoring-proposal.entity.js';
import { AuthoringProposalService } from './proposal/authoring-proposal.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([AuthoringProposal])],
  providers: [AuthoringCommitService, AuthoringProposalService],
  exports: [AuthoringCommitService, AuthoringProposalService],
})
export class AuthoringModule {}
