/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import type { DataSource } from 'typeorm';
import {
  ApprovedRenderContextService,
  validateApprovedRenderContextV1,
} from './approved-render-context.service.js';

describe('ApprovedRenderContextService', () => {
  it('builds deterministic NFC entries from project-scoped current sources', async () => {
    const dataSource = scriptedDataSource(defaultRows());
    const service = new ApprovedRenderContextService(dataSource);

    const context = await service.build({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
    });

    expect(context.context_version).toBe('approved-render-context.v1');
    expect(context.entries.map((entry) => entry.structure_id)).toEqual([
      'chapter-1',
      'outline-column-1',
      'section-1',
      'style-column-1',
      'workflow-title',
    ]);
    expect(context.entries).toEqual(
      expect.arrayContaining([
        {
          structure_id: 'workflow-title',
          source_kind: 'workflow_input',
          source_id: 'job-1',
          source_version: 'request-hash-1',
          label_nfc: '项目名称',
          presentation: 'heading_1',
        },
        {
          structure_id: 'chapter-1',
          source_kind: 'directory',
          source_id: 'directory-1',
          source_version: '3',
          label_nfc: '第一章',
          presentation: 'heading_1',
        },
        {
          structure_id: 'section-1',
          source_kind: 'directory',
          source_id: 'directory-1',
          source_version: '3',
          label_nfc: '第一节',
          presentation: 'heading_2',
        },
        {
          structure_id: 'outline-column-1',
          source_kind: 'outline',
          source_id: 'outline-1',
          source_version: '4',
          label_nfc: '系\u7edf组成'.normalize('NFC'),
          presentation: 'column',
        },
        {
          structure_id: 'style-column-1',
          source_kind: 'style_template',
          source_id: 'style-1',
          source_version: '2026-07-26T00:00:00.000Z',
          label_nfc: '学习目标',
          presentation: 'column',
        },
      ]),
    );
    for (const call of dataSource.query.mock.calls) {
      const parameters: unknown = call[1];
      expect(Array.isArray(parameters)).toBe(true);
      expect(parameters as unknown[]).toContain('project-1');
    }
    expect(dataSource.query.mock.calls[2][1]).toEqual([
      'project-1',
      'chapter-1',
      'section-1',
    ]);
  });

  it.each([
    [
      'cross-project source',
      (rows: ReturnType<typeof defaultRows>) => {
        rows[1][0].project_id = 'project-other';
      },
    ],
    [
      'stale directory source version',
      (rows: ReturnType<typeof defaultRows>) => {
        (rows[0][0].input as Record<string, unknown>).directory_version_id =
          'stale-directory';
      },
    ],
    [
      'duplicate structure IDs',
      (rows: ReturnType<typeof defaultRows>) => {
        (
          (rows[3][0].features as Record<string, unknown>)
            .structure_tree as Record<string, unknown>
        ).id = 'chapter-1';
      },
    ],
    [
      'invalid label',
      (rows: ReturnType<typeof defaultRows>) => {
        (
          (rows[3][0].features as Record<string, unknown>)
            .structure_tree as Record<string, unknown>
        ).title = 'unsafe--label';
      },
    ],
    [
      'unsupported presentation',
      (rows: ReturnType<typeof defaultRows>) => {
        (
          (rows[3][0].features as Record<string, unknown>)
            .structure_tree as Record<string, unknown>
        ).presentation = 'html';
      },
    ],
  ])('rejects %s', async (_label, mutate) => {
    const rows = defaultRows();
    mutate(rows);
    const service = new ApprovedRenderContextService(scriptedDataSource(rows));

    await expect(
      service.build({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
      }),
    ).rejects.toThrow('RENDER_CONTEXT_INVALID');
  });

  it('accepts the persisted directory node-array shape', async () => {
    const rows = defaultRows();
    const context = await new ApprovedRenderContextService(
      scriptedDataSource(rows),
    ).build({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
    });

    expect(
      context.entries.find((entry) => entry.structure_id === 'chapter-1'),
    ).toEqual(
      expect.objectContaining({
        source_kind: 'directory',
        source_version: '3',
        label_nfc: '第一章',
      }),
    );
  });

  it('closes directory entries to the workflow target section and its chapter ancestor', async () => {
    const rows = defaultRows();
    rows[1][0].content = [
      ...(rows[1][0].content as unknown[]),
      {
        node_id: 'chapter-2',
        parent_node_id: null,
        node_type: 'chapter',
        title: '越界章',
      },
      {
        node_id: 'section-2',
        parent_node_id: 'chapter-2',
        node_type: 'section',
        title: '越界节',
      },
    ];
    const context = await new ApprovedRenderContextService(
      scriptedDataSource(rows),
    ).build({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
    });

    expect(
      context.entries
        .filter((entry) => entry.source_kind === 'directory')
        .map((entry) => entry.structure_id),
    ).toEqual(['chapter-1', 'section-1']);
    expect(JSON.stringify(context.entries)).not.toContain('越界');
  });

  it.each([
    [
      'missing target section',
      (rows: ReturnType<typeof defaultRows>) => {
        rows[1][0].content = (rows[1][0].content as unknown[]).filter(
          (raw) => (raw as Record<string, unknown>).node_id !== 'section-1',
        );
      },
    ],
    [
      'target section outside the target chapter',
      (rows: ReturnType<typeof defaultRows>) => {
        (
          rows[1][0].content as Array<Record<string, unknown>>
        )[1].parent_node_id = 'chapter-other';
      },
    ],
  ])(
    'rejects a structurally inconsistent directory with %s',
    async (_label, mutate) => {
      const rows = defaultRows();
      mutate(rows);

      await expect(
        new ApprovedRenderContextService(scriptedDataSource(rows)).build({
          workflow_job_id: 'job-1',
          project_id: 'project-1',
        }),
      ).rejects.toThrow('RENDER_CONTEXT_INVALID');
    },
  );

  it.each([
    ['directory', 1],
    ['outline', 2],
    ['style template', 3],
  ])(
    'rejects a missing current %s row when the workflow pins that source',
    async (_label, rowIndex) => {
      const rows = defaultRows();
      rows[rowIndex] = [];

      await expect(
        new ApprovedRenderContextService(scriptedDataSource(rows)).build({
          workflow_job_id: 'job-1',
          project_id: 'project-1',
        }),
      ).rejects.toThrow('RENDER_CONTEXT_INVALID');
    },
  );

  it('uses the same closed validator for build and recovery inputs', () => {
    expect(() =>
      validateApprovedRenderContextV1({
        context_version: 'approved-render-context.v1',
        entries: [
          {
            structure_id: 'same',
            source_kind: 'outline',
            source_id: 'outline-1',
            source_version: '1',
            label_nfc: '合法',
            presentation: 'heading_1',
          },
          {
            structure_id: 'same',
            source_kind: 'directory',
            source_id: 'directory-1',
            source_version: '1',
            label_nfc: '重复',
            presentation: 'heading_2',
          },
        ],
      }),
    ).toThrow('RENDER_CONTEXT_INVALID');
  });
});

function defaultRows(): Array<Array<Record<string, unknown>>> {
  return [
    [
      {
        id: 'job-1',
        project_id: 'project-1',
        request_hash: 'request-hash-1',
        input: {
          chapter_node_id: 'chapter-1',
          section_node_id: 'section-1',
          directory_version_id: 'directory-1',
          directory_version: 3,
          outline_version_id: 'outline-1',
          outline_version: 4,
          style_template_id: 'style-1',
          style_template_version: '2026-07-26T00:00:00.000Z',
          render_context_entries: [
            {
              structure_id: 'workflow-title',
              label: '项目名称',
              presentation: 'heading_1',
            },
          ],
        },
      },
    ],
    [
      {
        id: 'directory-1',
        project_id: 'project-1',
        version_number: 3,
        content: [
          {
            node_id: 'chapter-1',
            parent_node_id: null,
            node_type: 'chapter',
            title: '第一章',
          },
          {
            node_id: 'section-1',
            parent_node_id: 'chapter-1',
            node_type: 'section',
            title: '第一节',
          },
        ],
      },
    ],
    [
      {
        id: 'outline-1',
        project_id: 'project-1',
        version_number: 4,
        content: {
          sections: [
            {
              structure_id: 'outline-column-1',
              column: '系\u7edf组成',
              presentation: 'column',
            },
          ],
        },
      },
    ],
    [
      {
        id: 'style-1',
        project_id: 'project-1',
        updated_at: new Date('2026-07-26T00:00:00.000Z'),
        features: {
          structure_tree: {
            id: 'style-column-1',
            title: '学习目标',
            presentation: 'column',
            children: [],
          },
        },
      },
    ],
  ];
}

function scriptedDataSource(
  rows: Array<Array<Record<string, unknown>>>,
): DataSource & { query: jest.Mock } {
  let index = 0;
  return {
    query: jest.fn(() => Promise.resolve(rows[index++] ?? [])),
  } as unknown as DataSource & { query: jest.Mock };
}
