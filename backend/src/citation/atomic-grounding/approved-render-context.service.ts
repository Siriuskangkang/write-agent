import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  APPROVED_RENDER_CONTEXT_VERSION,
  type SealedApprovedRenderContextV1,
} from './contracts.js';
import { isWellFormedUnicodeScalarV1 } from './well-formed-unicode.js';

export interface ApprovedRenderContextJob {
  workflow_job_id: string;
  project_id: string;
}

type RenderEntry = SealedApprovedRenderContextV1['entries'][number];
type Presentation = RenderEntry['presentation'];

const PRESENTATIONS = [
  'heading_1',
  'heading_2',
  'heading_3',
  'column',
] as const;
const SOURCE_KINDS = [
  'workflow_input',
  'directory',
  'outline',
  'style_template',
] as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;

@Injectable()
export class ApprovedRenderContextService {
  constructor(private readonly dataSource: DataSource) {}

  async build(
    job: ApprovedRenderContextJob,
  ): Promise<SealedApprovedRenderContextV1> {
    try {
      const workflow = one(
        await this.dataSource.query(
          `SELECT id, project_id, request_hash, input
             FROM workflow_jobs
            WHERE id = ? AND project_id = ?`,
          [job.workflow_job_id, job.project_id],
        ),
      );
      assertScoped(workflow, job.workflow_job_id, job.project_id);
      const input = jsonRecord(workflow.input);

      const directory = optionalOne(
        await this.dataSource.query(
          `SELECT id, project_id, version_number, content
             FROM directory_versions
            WHERE project_id = ? AND is_current = 1
            ORDER BY version_number DESC, id`,
          [job.project_id],
        ),
      );
      assertPinnedSourcePresent(input, 'directory', directory);
      if (directory) {
        assertProject(directory, job.project_id);
        assertExpectedSource(input, 'directory', directory);
      }

      const chapterNodeId =
        typeof input.chapter_node_id === 'string'
          ? input.chapter_node_id
          : null;
      const sectionNodeId =
        typeof input.section_node_id === 'string'
          ? input.section_node_id
          : null;
      const outlineScope = chapterNodeId
        ? sectionNodeId
          ? ' AND chapter_node_id = ? AND section_node_id = ?'
          : ' AND chapter_node_id = ? AND section_node_id IS NULL'
        : '';
      const outlineParameters = [
        job.project_id,
        ...(chapterNodeId ? [chapterNodeId] : []),
        ...(chapterNodeId && sectionNodeId ? [sectionNodeId] : []),
      ];
      const outline = optionalOne(
        await this.dataSource.query(
          `SELECT id, project_id, version_number, content
             FROM outline_versions
            WHERE project_id = ? AND is_current = 1${outlineScope}
            ORDER BY version_number DESC, id`,
          outlineParameters,
        ),
      );
      assertPinnedSourcePresent(input, 'outline', outline);
      if (outline) {
        assertProject(outline, job.project_id);
        assertExpectedSource(input, 'outline', outline);
      }

      const styleTemplate = optionalOne(
        await this.dataSource.query(
          `SELECT id, project_id, updated_at, features
             FROM style_templates
            WHERE project_id = ? AND status = 'completed'
            ORDER BY updated_at DESC, id`,
          [job.project_id],
        ),
      );
      assertPinnedSourcePresent(input, 'style_template', styleTemplate);
      if (styleTemplate) {
        assertProject(styleTemplate, job.project_id);
        assertExpectedSource(input, 'style_template', styleTemplate);
      }

      const entries: RenderEntry[] = [];
      entries.push(...workflowEntries(workflow, input));
      if (directory) {
        entries.push(
          ...directoryEntries(directory, chapterNodeId, sectionNodeId),
        );
      }
      if (outline) entries.push(...outlineEntries(outline));
      if (styleTemplate) entries.push(...styleEntries(styleTemplate));
      return validateApprovedRenderContextV1({
        context_version: APPROVED_RENDER_CONTEXT_VERSION,
        entries,
      });
    } catch {
      return renderContextInvalid();
    }
  }
}

export function validateApprovedRenderContextV1(
  value: unknown,
): SealedApprovedRenderContextV1 {
  try {
    const context = exactRecord(value, ['context_version', 'entries']);
    if (
      context.context_version !== APPROVED_RENDER_CONTEXT_VERSION ||
      !Array.isArray(context.entries)
    ) {
      return renderContextInvalid();
    }
    const entries = context.entries.map((raw) => {
      const entry = exactRecord(raw, [
        'structure_id',
        'source_kind',
        'source_id',
        'source_version',
        'label_nfc',
        'presentation',
      ]);
      const structureId = safeId(entry.structure_id);
      const sourceId = safeId(entry.source_id);
      const sourceVersion = safeVersion(entry.source_version);
      const label = safeLabel(entry.label_nfc);
      if (
        !SOURCE_KINDS.includes(entry.source_kind as RenderEntry['source_kind'])
      ) {
        return renderContextInvalid();
      }
      if (!PRESENTATIONS.includes(entry.presentation as Presentation)) {
        return renderContextInvalid();
      }
      return {
        structure_id: structureId,
        source_kind: entry.source_kind as RenderEntry['source_kind'],
        source_id: sourceId,
        source_version: sourceVersion,
        label_nfc: label,
        presentation: entry.presentation as Presentation,
      };
    });
    entries.sort((left, right) =>
      left.structure_id < right.structure_id
        ? -1
        : left.structure_id > right.structure_id
          ? 1
          : 0,
    );
    if (
      entries.some(
        (entry, index) =>
          index > 0 && entry.structure_id === entries[index - 1].structure_id,
      )
    ) {
      return renderContextInvalid();
    }
    return {
      context_version: APPROVED_RENDER_CONTEXT_VERSION,
      entries,
    };
  } catch {
    return renderContextInvalid();
  }
}

function workflowEntries(
  workflow: Record<string, unknown>,
  input: Record<string, unknown>,
): RenderEntry[] {
  const sourceId = safeId(workflow.id);
  const sourceVersion = safeVersion(workflow.request_hash);
  const explicit = input.render_context_entries;
  const entries: RenderEntry[] = [];
  if (Array.isArray(explicit)) {
    for (const raw of explicit) {
      const item = plainRecord(raw);
      entries.push({
        structure_id: safeId(item.structure_id),
        source_kind: 'workflow_input',
        source_id: sourceId,
        source_version: sourceVersion,
        label_nfc: safeLabel(item.label ?? item.label_nfc),
        presentation: presentation(item.presentation),
      });
    }
  }
  const common: Array<[string, unknown, Presentation]> = [
    ['workflow:chapter_title', input.chapter_title, 'heading_1'],
    ['workflow:section_title', input.section_title, 'heading_2'],
  ];
  for (const [structureId, label, presentationValue] of common) {
    if (typeof label !== 'string' || label.length === 0) continue;
    entries.push({
      structure_id: structureId,
      source_kind: 'workflow_input',
      source_id: sourceId,
      source_version: sourceVersion,
      label_nfc: safeLabel(label),
      presentation: presentationValue,
    });
  }
  return entries;
}

function directoryEntries(
  row: Record<string, unknown>,
  chapterNodeId: string | null,
  sectionNodeId: string | null,
): RenderEntry[] {
  if (
    !chapterNodeId ||
    (sectionNodeId !== null && sectionNodeId === chapterNodeId)
  ) {
    return renderContextInvalid();
  }
  const sourceId = safeId(row.id);
  const sourceVersion = safeVersion(row.version_number);
  const decoded = decodedJson(row.content);
  let rawNodes: unknown[];
  if (Array.isArray(decoded)) {
    rawNodes = decoded;
  } else {
    const content = plainRecord(decoded);
    rawNodes = Array.isArray(content.nodes) ? content.nodes : [];
  }
  const nodes = new Map<
    string,
    {
      raw: Record<string, unknown>;
      nodeId: string;
      parentNodeId: string | null;
      nodeType: 'chapter' | 'section';
    }
  >();
  for (const raw of rawNodes) {
    const node = plainRecord(raw);
    const nodeId = safeId(node.structure_id ?? node.node_id ?? node.id);
    if (nodes.has(nodeId)) return renderContextInvalid();
    const nodeType = node.node_type;
    if (nodeType !== 'chapter' && nodeType !== 'section') {
      return renderContextInvalid();
    }
    const parentNodeId =
      node.parent_node_id === undefined || node.parent_node_id === null
        ? null
        : safeId(node.parent_node_id);
    nodes.set(nodeId, { raw: node, nodeId, parentNodeId, nodeType });
  }
  const chapter = nodes.get(chapterNodeId);
  if (!chapter || chapter.nodeType !== 'chapter') {
    return renderContextInvalid();
  }
  const target = sectionNodeId ? nodes.get(sectionNodeId) : chapter;
  if (!target || (sectionNodeId && target.nodeType !== 'section')) {
    return renderContextInvalid();
  }
  const selected = new Map<string, typeof target & object>();
  const seen = new Set<string>();
  let cursor: typeof target | undefined = target;
  let containsTargetChapter = false;
  while (cursor) {
    if (seen.has(cursor.nodeId)) return renderContextInvalid();
    seen.add(cursor.nodeId);
    selected.set(cursor.nodeId, cursor);
    if (cursor.nodeId === chapterNodeId) containsTargetChapter = true;
    if (cursor.parentNodeId === null) break;
    cursor = nodes.get(cursor.parentNodeId);
    if (!cursor) return renderContextInvalid();
  }
  if (!containsTargetChapter) return renderContextInvalid();

  return [...selected.values()].map(({ raw: node, nodeId, nodeType }) => {
    const derivedPresentation: Presentation =
      nodeType === 'chapter' ? 'heading_1' : 'heading_2';
    return {
      structure_id: nodeId,
      source_kind: 'directory',
      source_id: sourceId,
      source_version: sourceVersion,
      label_nfc: safeLabel(node.label ?? node.title),
      presentation:
        node.presentation === undefined
          ? derivedPresentation
          : presentation(node.presentation),
    };
  });
}

function outlineEntries(row: Record<string, unknown>): RenderEntry[] {
  const sourceId = safeId(row.id);
  const sourceVersion = safeVersion(row.version_number);
  const content = jsonRecord(row.content);
  const entries: RenderEntry[] = [];
  if (typeof content.node_title === 'string' && content.node_title.length > 0) {
    entries.push({
      structure_id: safeId(
        content.structure_id ?? `outline:${sourceId}:node-title`,
      ),
      source_kind: 'outline',
      source_id: sourceId,
      source_version: sourceVersion,
      label_nfc: safeLabel(content.node_title),
      presentation:
        content.presentation === undefined
          ? 'heading_2'
          : presentation(content.presentation),
    });
  }
  if (Array.isArray(content.sections)) {
    content.sections.forEach((raw, index) => {
      const section = plainRecord(raw);
      entries.push({
        structure_id: safeId(
          section.structure_id ?? `outline:${sourceId}:column:${index}`,
        ),
        source_kind: 'outline',
        source_id: sourceId,
        source_version: sourceVersion,
        label_nfc: safeLabel(section.label ?? section.column),
        presentation:
          section.presentation === undefined
            ? 'column'
            : presentation(section.presentation),
      });
    });
  }
  return entries;
}

function styleEntries(row: Record<string, unknown>): RenderEntry[] {
  const sourceId = safeId(row.id);
  const sourceVersion = stableDateVersion(row.updated_at);
  const features = jsonRecord(row.features);
  if (!features.structure_tree) return [];
  const entries: RenderEntry[] = [];
  const visit = (raw: unknown): void => {
    const node = plainRecord(raw);
    entries.push({
      structure_id: safeId(node.structure_id ?? node.id),
      source_kind: 'style_template',
      source_id: sourceId,
      source_version: sourceVersion,
      label_nfc: safeLabel(node.label ?? node.title),
      presentation:
        node.presentation === undefined
          ? 'column'
          : presentation(node.presentation),
    });
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(features.structure_tree);
  return entries;
}

function assertScoped(
  row: Record<string, unknown>,
  workflowJobId: string,
  projectId: string,
): void {
  if (row.id !== workflowJobId) renderContextInvalid();
  assertProject(row, projectId);
}

function assertProject(row: Record<string, unknown>, projectId: string): void {
  if (row.project_id !== projectId) renderContextInvalid();
}

function assertExpectedSource(
  input: Record<string, unknown>,
  prefix: 'directory' | 'outline' | 'style_template',
  row: Record<string, unknown>,
): void {
  const expectedId = input[`${prefix}_id`] ?? input[`${prefix}_version_id`];
  if (expectedId !== undefined && expectedId !== row.id) renderContextInvalid();
  const expectedVersion = input[`${prefix}_version`];
  if (expectedVersion === undefined) return;
  if (
    typeof expectedVersion !== 'string' &&
    (typeof expectedVersion !== 'number' ||
      !Number.isSafeInteger(expectedVersion))
  ) {
    renderContextInvalid();
  }
  const current =
    prefix === 'style_template'
      ? stableDateVersion(row.updated_at)
      : safeVersion(row.version_number);
  if (`${expectedVersion}` !== current) renderContextInvalid();
}

function assertPinnedSourcePresent(
  input: Record<string, unknown>,
  prefix: 'directory' | 'outline' | 'style_template',
  row: Record<string, unknown> | null,
): void {
  const keys = [`${prefix}_id`, `${prefix}_version_id`, `${prefix}_version`];
  if (
    row === null &&
    keys.some((key) => Object.prototype.hasOwnProperty.call(input, key))
  ) {
    renderContextInvalid();
  }
}

function presentation(value: unknown): Presentation {
  if (!PRESENTATIONS.includes(value as Presentation)) {
    return renderContextInvalid();
  }
  return value as Presentation;
}

function safeId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    return renderContextInvalid();
  }
  return value.normalize('NFC');
}

function safeVersion(value: unknown): string {
  const version =
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : value;
  if (
    typeof version !== 'string' ||
    version.length === 0 ||
    version.normalize('NFC') !== version ||
    !isWellFormedUnicodeScalarV1(version) ||
    Buffer.byteLength(version, 'utf8') > 512 ||
    hasForbiddenControl(version)
  ) {
    return renderContextInvalid();
  }
  return version;
}

function stableDateVersion(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return renderContextInvalid();
}

function safeLabel(value: unknown): string {
  if (typeof value !== 'string' || !isWellFormedUnicodeScalarV1(value)) {
    return renderContextInvalid();
  }
  const label = value.normalize('NFC');
  if (
    label.length === 0 ||
    Buffer.byteLength(label, 'utf8') > 200 ||
    hasForbiddenControl(label) ||
    label.includes('<') ||
    label.includes('>') ||
    label.includes('--')
  ) {
    return renderContextInvalid();
  }
  return label;
}

function hasForbiddenControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return plainRecord(decodedJson(value));
}

function decodedJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return renderContextInvalid();
    }
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const item = plainRecord(value);
  const actual = Reflect.ownKeys(item);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    return renderContextInvalid();
  }
  return item;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return renderContextInvalid();
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return renderContextInvalid();
  }
  return value as Record<string, unknown>;
}

function one(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) {
    return renderContextInvalid();
  }
  return plainRecord(value[0]);
}

function optionalOne(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length > 1) {
    return renderContextInvalid();
  }
  return value.length === 0 ? null : plainRecord(value[0]);
}

function renderContextInvalid(): never {
  throw new TypeError('RENDER_CONTEXT_INVALID');
}
