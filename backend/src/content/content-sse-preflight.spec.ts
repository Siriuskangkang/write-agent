import { ForbiddenException } from '@nestjs/common';
import { ContentController } from './content.controller.js';
import { DirectoryController } from './directory.controller.js';
import { OutlineController } from './outline.controller.js';

function emptyEvents(): AsyncGenerator<never> {
  return (async function* () {
    await Promise.resolve();
    yield* [] as never[];
  })();
}

function createResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    json: jest.fn(),
  };
}

describe('SSE project ownership preflight', () => {
  const contentService = {
    assertProjectOwner: jest.fn(),
    generateDirectory: jest.fn(emptyEvents),
    generateOutline: jest.fn(emptyEvents),
    saveOutlineFromGeneration: jest.fn(),
    generateContent: jest.fn(emptyEvents),
    rewriteContent: jest.fn(emptyEvents),
    expandContent: jest.fn(emptyEvents),
    compressContent: jest.fn(emptyEvents),
  };
  const redis = { set: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    contentService.assertProjectOwner.mockRejectedValue(
      new ForbiddenException('无权访问该项目'),
    );
  });

  it.each([
    [
      'directory',
      async () =>
        new DirectoryController(
          contentService as never,
          redis as never,
        ).generate(
          { sub: 'other-user' },
          'project-1',
          {} as never,
          { headers: {} } as never,
          createResponse() as never,
        ),
    ],
    [
      'outline',
      async () =>
        new OutlineController(contentService as never, redis as never).generate(
          { sub: 'other-user' },
          'project-1',
          {} as never,
          { headers: {} } as never,
          createResponse() as never,
        ),
    ],
    [
      'content',
      async () =>
        new ContentController(contentService as never, redis as never).generate(
          { sub: 'other-user' },
          'project-1',
          {} as never,
          { headers: {} } as never,
          createResponse() as never,
        ),
    ],
    [
      'rewrite',
      async () =>
        new ContentController(contentService as never, redis as never).rewrite(
          { sub: 'other-user' },
          'project-1',
          'result-1',
          {} as never,
          { headers: {} } as never,
          createResponse() as never,
        ),
    ],
    [
      'expand',
      async () =>
        new ContentController(contentService as never, redis as never).expand(
          { sub: 'other-user' },
          'project-1',
          'result-1',
          {} as never,
          { headers: {} } as never,
          createResponse() as never,
        ),
    ],
    [
      'compress',
      async () =>
        new ContentController(contentService as never, redis as never).compress(
          { sub: 'other-user' },
          'project-1',
          'result-1',
          {} as never,
          { headers: {} } as never,
          createResponse() as never,
        ),
    ],
  ])(
    '%s awaits owner authorization before initializing SSE',
    async (_name, invoke) => {
      await expect(invoke()).rejects.toBeInstanceOf(ForbiddenException);
      expect(contentService.assertProjectOwner).toHaveBeenCalledWith(
        'other-user',
        'project-1',
      );
    },
  );
});
