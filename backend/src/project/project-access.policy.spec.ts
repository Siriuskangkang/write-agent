import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Project } from './entities/project.entity.js';
import { ProjectAccessPolicy } from './project-access.policy.js';

describe('ProjectAccessPolicy', () => {
  const projectRepository = {
    findOne: jest.fn(),
  };

  let policy: ProjectAccessPolicy;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        ProjectAccessPolicy,
        { provide: getRepositoryToken(Project), useValue: projectRepository },
      ],
    }).compile();
    policy = module.get(ProjectAccessPolicy);
  });

  it('returns the project for its owner', async () => {
    const project = { id: 'project-1', user_id: 'owner-1' } as Project;
    projectRepository.findOne.mockResolvedValue(project);

    await expect(policy.assertOwner('owner-1', 'project-1')).resolves.toBe(
      project,
    );
  });

  it('rejects a foreign project with 403', async () => {
    projectRepository.findOne.mockResolvedValue({
      id: 'project-1',
      user_id: 'owner-1',
    });

    await expect(
      policy.assertOwner('other-user', 'project-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 404 when the project does not exist', async () => {
    projectRepository.findOne.mockResolvedValue(null);

    await expect(
      policy.assertOwner('owner-1', 'missing-project'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
