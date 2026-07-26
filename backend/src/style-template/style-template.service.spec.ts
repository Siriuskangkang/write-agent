import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProjectAccessPolicy } from '../project/project-access.policy.js';
import { StyleTemplate } from './entities/style-template.entity.js';
import { StyleTemplateService } from './style-template.service.js';

describe('StyleTemplateService', () => {
  const templateRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    update: jest.fn(),
    create: jest.fn((value: Partial<StyleTemplate>) => value),
    save: jest.fn(),
    remove: jest.fn(),
  };
  const projectAccessPolicy = { assertOwner: jest.fn() };

  let service: StyleTemplateService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        StyleTemplateService,
        {
          provide: getRepositoryToken(StyleTemplate),
          useValue: templateRepository,
        },
        { provide: ProjectAccessPolicy, useValue: projectAccessPolicy },
      ],
    }).compile();
    service = module.get(StyleTemplateService);
  });

  it('does not delete templates when a user creates a style for another project', async () => {
    projectAccessPolicy.assertOwner.mockRejectedValue(
      new ForbiddenException('无权访问该项目'),
    );

    await expect(
      service.createFromText('other-user', 'project-owned-by-someone-else'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(templateRepository.find).not.toHaveBeenCalled();
    expect(templateRepository.remove).not.toHaveBeenCalled();
  });

  it('returns 404 when a template is not in an owned project', async () => {
    projectAccessPolicy.assertOwner.mockResolvedValue({ id: 'owned-project' });
    templateRepository.findOne.mockResolvedValue(null);

    await expect(
      service.findOneForUser('owner-1', 'foreign-template', 'owned-project'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('persists dto features as the base before applying a panel assignment', async () => {
    const existing = {
      id: 'template-1',
      projectId: 'project-1',
      features: {
        structure_tree: { title: 'old', children: [] },
      },
    } as StyleTemplate;
    const persisted = {
      ...existing,
      features: {
        structure_tree: { title: 'new', children: [] },
        panel_assignment: { panel_a: [], panel_b: [] },
      },
    } as StyleTemplate;
    projectAccessPolicy.assertOwner.mockResolvedValue({ id: 'project-1' });
    templateRepository.findOne.mockResolvedValue(existing);
    templateRepository.findOneOrFail.mockResolvedValue(persisted);

    await expect(
      service.updateForUser('owner-1', 'project-1', 'template-1', {
        features: { structure_tree: { title: 'new', children: [] } },
        panel_assignment: { panel_a: [], panel_b: [] },
      }),
    ).resolves.toEqual(persisted);

    expect(templateRepository.update).toHaveBeenCalledWith(
      { id: 'template-1', projectId: 'project-1' },
      expect.objectContaining({
        features: {
          structure_tree: { title: 'new', children: [] },
          panel_assignment: { panel_a: [], panel_b: [] },
        },
      }),
    );
  });
});
