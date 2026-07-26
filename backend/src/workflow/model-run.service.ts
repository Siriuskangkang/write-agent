import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ModelOperationMatchIdentity } from '../llm/model-types.js';
import { ModelRun } from './entities/model-run.entity.js';

export interface ModelRunRequestMetadata {
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  timeout_ms?: number;
  response_schema_id?: string;
  response_schema_version?: string;
  response_schema_sha256?: string;
  trace_id?: string;
  retry_attempt?: number;
  repair_attempt?: number;
  attempt_kind?: ModelAttemptKind;
  generation_attempt?: number;
  workflow_node?: string;
  structured_output?: boolean;
  response_mode?: 'text' | 'structured' | 'tool';
  tags?: string[];
}

export interface ModelRunUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
}

export interface CreateModelRunInput {
  workflow_job_id: string;
  provider: string;
  model: string;
  attempt_number?: number;
  workflow_node?: string;
  attempt_kind?: ModelAttemptKind | 'legacy';
  generation_attempt?: number;
  network_attempt?: number;
  repair_attempt?: number;
  request_metadata: ModelRunRequestMetadata | null;
  prompt_sha256: string | null;
  usage: ModelRunUsage | null;
  cost_usd: string | null;
  status: string;
  error_code?: string | null;
  error_message?: string | null;
  completed_at?: Date | null;
  latency_ms?: number | null;
  operation_key?: string | null;
  request_fingerprint?: string | null;
}

export interface StartModelRunInput {
  workflow_job_id: string;
  provider: string;
  model: string;
  workflow_node: string;
  attempt_kind: ModelAttemptKind;
  generation_attempt: number;
  network_attempt: number;
  repair_attempt: number;
  request_metadata: ModelRunRequestMetadata | null;
  prompt_sha256: string | null;
  operation_key?: string | null;
  request_fingerprint?: string | null;
}

export type ModelAttemptKind = 'initial' | 'network_retry' | 'repair';

export interface FinishModelRunInput {
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  usage: ModelRunUsage | null;
  cost_usd: string | null;
  error_code: string | null;
  error_message: string | null;
  latency_ms: number;
  completed_at: Date;
}

const METADATA_KEYS = new Set<keyof ModelRunRequestMetadata>([
  'temperature',
  'top_p',
  'max_output_tokens',
  'timeout_ms',
  'response_schema_id',
  'response_schema_version',
  'response_schema_sha256',
  'trace_id',
  'retry_attempt',
  'repair_attempt',
  'attempt_kind',
  'generation_attempt',
  'workflow_node',
  'structured_output',
  'response_mode',
  'tags',
]);
const SENSITIVE_METADATA_KEY_PARTS = new Set([
  'prompt',
  'prompts',
  'message',
  'messages',
  'content',
  'contents',
  'instruction',
  'instructions',
  'system',
  'user',
  'assistant',
  'raw',
  'input',
  'output',
  'body',
  'text',
]);
const USAGE_KEYS = new Set<keyof ModelRunUsage>([
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cached_input_tokens',
  'cache_creation_input_tokens',
  'reasoning_tokens',
]);
const MAX_METADATA_BYTES = 4096;
const MAX_METADATA_DEPTH = 4;
const MAX_TAG_COUNT = 16;
const MAX_TAG_BYTES = 64;
const SAFE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

@Injectable()
export class ModelRunService {
  constructor(
    @InjectRepository(ModelRun)
    private readonly repository: Repository<ModelRun>,
  ) {}

  async create(input: CreateModelRunInput): Promise<ModelRun> {
    const requestMetadata = validateRequestMetadata(input.request_metadata);
    const usage = validateUsage(input.usage);
    const promptSha256 = validatePromptHash(input.prompt_sha256);
    const costUsd = validateCost(input.cost_usd);
    const attemptNumber = validateAttempt(input.attempt_number ?? 1);
    const workflowNode = validateWorkflowNode(input.workflow_node ?? 'legacy');
    const attemptKind = validateAttemptKind(input.attempt_kind ?? 'legacy');
    const generationAttempt = validateAttempt(input.generation_attempt ?? 1);
    const networkAttempt = validateNonNegativeAttempt(
      input.network_attempt ?? 0,
      'network_attempt',
    );
    const repairAttempt = validateNonNegativeAttempt(
      input.repair_attempt ?? 0,
      'repair_attempt',
    );
    const latencyMs = validateLatency(input.latency_ms ?? null);
    const operationKey = validateOperationKey(input.operation_key ?? null);
    const requestFingerprint = validateOperationKey(
      input.request_fingerprint ?? null,
    );
    return this.repository.save(
      this.repository.create({
        ...input,
        attempt_number: attemptNumber,
        workflow_node: workflowNode,
        attempt_kind: attemptKind,
        generation_attempt: generationAttempt,
        network_attempt: networkAttempt,
        repair_attempt: repairAttempt,
        request_metadata: requestMetadata,
        usage,
        prompt_sha256: promptSha256,
        cost_usd: costUsd,
        error_code: input.error_code ?? null,
        error_message: input.error_message ?? null,
        completed_at: input.completed_at ?? null,
        latency_ms: latencyMs,
        operation_key: operationKey,
        request_fingerprint: requestFingerprint,
      }),
    );
  }

  async startAttempt(input: StartModelRunInput): Promise<ModelRun> {
    const workflowNode = validateWorkflowNode(input.workflow_node);
    const attemptKind = validateAttemptKind(input.attempt_kind);
    const generationAttempt = validateAttempt(input.generation_attempt);
    const networkAttempt = validateNonNegativeAttempt(
      input.network_attempt,
      'network_attempt',
    );
    const repairAttempt = validateNonNegativeAttempt(
      input.repair_attempt,
      'repair_attempt',
    );
    const requestMetadata = validateRequestMetadata(input.request_metadata);
    const promptSha256 = validatePromptHash(input.prompt_sha256);
    const operationKey = validateOperationKey(input.operation_key ?? null);
    const requestFingerprint = validateOperationKey(
      input.request_fingerprint ?? null,
    );

    return this.repository.manager.transaction(async (manager) => {
      const jobRows: unknown = await manager.query(
        `SELECT id
           FROM workflow_jobs
          WHERE id = ?
          FOR UPDATE`,
        [input.workflow_job_id],
      );
      if (!Array.isArray(jobRows) || jobRows.length !== 1) {
        throw new BadRequestException('工作流任务不存在');
      }
      const attemptRows: unknown = await manager.query(
        `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS nextAttempt
           FROM model_runs
          WHERE workflow_job_id = ?
            AND workflow_node = ?`,
        [input.workflow_job_id, workflowNode],
      );
      const attemptNumber = readAllocatedAttempt(attemptRows);
      const repository = manager.getRepository(ModelRun);
      return repository.save(
        repository.create({
          ...input,
          attempt_number: attemptNumber,
          workflow_node: workflowNode,
          attempt_kind: attemptKind,
          generation_attempt: generationAttempt,
          network_attempt: networkAttempt,
          repair_attempt: repairAttempt,
          request_metadata: requestMetadata,
          prompt_sha256: promptSha256,
          operation_key: operationKey,
          request_fingerprint: requestFingerprint,
          usage: null,
          cost_usd: null,
          status: 'RUNNING',
          error_code: null,
          error_message: null,
          completed_at: null,
          latency_ms: null,
        }),
      );
    });
  }

  async findOperationState(
    workflowJobId: string,
    operationKey: string,
    expected?: ModelOperationMatchIdentity,
  ): Promise<'absent' | 'recorded' | 'mismatch'> {
    const validated = validateOperationKey(operationKey);
    if (!validated) throw new BadRequestException('模型操作标识不能为空');
    const existing = await this.repository.findOne({
      where: {
        workflow_job_id: workflowJobId,
        operation_key: validated,
      },
    });
    if (!existing) return 'absent';
    if (!expected) return 'recorded';
    const metadata = existing.request_metadata;
    return existing.request_fingerprint === expected.request_fingerprint &&
      existing.prompt_sha256 === expected.prompt_sha256 &&
      existing.provider === expected.provider &&
      existing.model === expected.model &&
      (metadata?.response_schema_id ?? null) === expected.schema_id &&
      (metadata?.response_schema_version ?? null) === expected.schema_version &&
      (metadata?.response_schema_sha256 ?? null) === expected.schema_sha256
      ? 'recorded'
      : 'mismatch';
  }

  async finishAttempt(id: string, input: FinishModelRunInput): Promise<void> {
    const usage = validateUsage(input.usage);
    const costUsd = validateCost(input.cost_usd);
    const latencyMs = validateLatency(input.latency_ms);
    const result = await this.repository.update(
      { id, status: 'RUNNING' },
      {
        status: input.status,
        usage,
        cost_usd: costUsd,
        error_code: input.error_code,
        error_message: input.error_message,
        latency_ms: latencyMs,
        completed_at: input.completed_at,
      },
    );
    if (result.affected === 1) return;
    const existing = await this.repository.findOneBy({ id });
    if (!existing) {
      throw new BadRequestException('模型运行记录不存在');
    }
    if (
      isIdenticalTerminal(existing, {
        ...input,
        usage,
        cost_usd: costUsd,
        latency_ms: latencyMs!,
      })
    ) {
      return;
    }
    throw new ConflictException('模型运行记录已进入不同的终态');
  }
}

function validateOperationKey(value: string | null): string | null {
  if (value === null) return null;
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new BadRequestException('模型操作标识必须是 64 位小写 SHA-256');
  }
  return value;
}

function validateRequestMetadata(
  value: ModelRunRequestMetadata | null,
): ModelRunRequestMetadata | null {
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw new BadRequestException('模型请求元数据必须是对象');
  }
  inspectMetadataTree(value, 0, true);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
    throw new BadRequestException(
      `模型请求元数据不能超过 ${MAX_METADATA_BYTES} 字节`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!METADATA_KEYS.has(key as keyof ModelRunRequestMetadata)) {
      throw new BadRequestException(`不允许的模型请求元数据字段: ${key}`);
    }
  }
  assertFiniteRange(value.temperature, 'temperature', 0, 2);
  assertFiniteRange(value.top_p, 'top_p', 0, 1);
  assertPositiveInteger(value.max_output_tokens, 'max_output_tokens');
  assertPositiveInteger(value.timeout_ms, 'timeout_ms');
  assertNonNegativeInteger(value.retry_attempt, 'retry_attempt');
  assertNonNegativeInteger(value.repair_attempt, 'repair_attempt');
  assertNonNegativeInteger(value.generation_attempt, 'generation_attempt');
  assertOptionalIdentifier(value.response_schema_id, 'response_schema_id', 100);
  assertOptionalIdentifier(
    value.response_schema_version,
    'response_schema_version',
    100,
  );
  if (
    value.response_schema_sha256 !== undefined &&
    (typeof value.response_schema_sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(value.response_schema_sha256))
  ) {
    throw new BadRequestException(
      'response_schema_sha256 必须是 64 位小写 SHA-256',
    );
  }
  assertOptionalIdentifier(value.trace_id, 'trace_id', 128);
  assertOptionalIdentifier(value.workflow_node, 'workflow_node', 100);
  if (value.attempt_kind !== undefined) {
    validateAttemptKind(value.attempt_kind);
  }
  if (
    value.structured_output !== undefined &&
    typeof value.structured_output !== 'boolean'
  ) {
    throw new BadRequestException('structured_output 必须是布尔值');
  }
  if (
    value.response_mode !== undefined &&
    (typeof value.response_mode !== 'string' ||
      !['text', 'structured', 'tool'].includes(value.response_mode))
  ) {
    throw new BadRequestException('response_mode 无效');
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags)) {
      throw new BadRequestException('tags 必须是字符串数组');
    }
    if (value.tags.length > MAX_TAG_COUNT) {
      throw new BadRequestException(`tags 最多包含 ${MAX_TAG_COUNT} 项`);
    }
    const uniqueTags = new Set<string>();
    for (const tag of value.tags) {
      if (
        typeof tag !== 'string' ||
        Buffer.byteLength(tag, 'utf8') === 0 ||
        Buffer.byteLength(tag, 'utf8') > MAX_TAG_BYTES ||
        !SAFE_TAG_PATTERN.test(tag)
      ) {
        throw new BadRequestException(
          `tag 必须是最多 ${MAX_TAG_BYTES} 字节的标识符`,
        );
      }
      if (uniqueTags.has(tag)) {
        throw new BadRequestException('tags 不能包含重复项');
      }
      uniqueTags.add(tag);
    }
  }
  return value;
}

function inspectMetadataTree(
  value: unknown,
  depth: number,
  root = false,
): void {
  if (depth > MAX_METADATA_DEPTH) {
    throw new BadRequestException(
      `模型请求元数据嵌套不能超过 ${MAX_METADATA_DEPTH} 层`,
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) inspectMetadataTree(item, depth + 1);
    return;
  }
  if (!isPlainObject(value)) {
    if (
      value !== null &&
      value !== undefined &&
      !['string', 'number', 'boolean'].includes(typeof value)
    ) {
      throw new BadRequestException('模型请求元数据必须是 JSON 值');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new BadRequestException('模型请求元数据不能包含无效数字');
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const approvedRootKey =
      root && METADATA_KEYS.has(key as keyof ModelRunRequestMetadata);
    if (!approvedRootKey && isSensitiveMetadataKey(key)) {
      throw new BadRequestException(`模型请求元数据禁止保存敏感字段: ${key}`);
    }
    inspectMetadataTree(nested, depth + 1);
  }
}

function isSensitiveMetadataKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return normalized
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((part) => SENSITIVE_METADATA_KEY_PARTS.has(part));
}

function validateUsage(value: ModelRunUsage | null): ModelRunUsage | null {
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw new BadRequestException('模型用量必须是对象');
  }
  for (const key of Object.keys(value)) {
    if (!USAGE_KEYS.has(key as keyof ModelRunUsage)) {
      throw new BadRequestException(`不允许的模型用量字段: ${key}`);
    }
  }
  assertNonNegativeInteger(value.input_tokens, 'input_tokens', true);
  assertNonNegativeInteger(value.output_tokens, 'output_tokens', true);
  assertNonNegativeInteger(value.total_tokens, 'total_tokens', true);
  assertNonNegativeInteger(value.cached_input_tokens, 'cached_input_tokens');
  assertNonNegativeInteger(
    value.cache_creation_input_tokens,
    'cache_creation_input_tokens',
  );
  assertNonNegativeInteger(value.reasoning_tokens, 'reasoning_tokens');
  const calculatedTotal = value.input_tokens + value.output_tokens;
  if (
    !Number.isSafeInteger(calculatedTotal) ||
    value.total_tokens !== calculatedTotal
  ) {
    throw new BadRequestException(
      'total_tokens 必须等于 input_tokens 与 output_tokens 之和',
    );
  }
  if ((value.cached_input_tokens ?? 0) > value.input_tokens) {
    throw new BadRequestException('cached_input_tokens 不能超过 input_tokens');
  }
  return value;
}

function validatePromptHash(value: string | null): string | null {
  if (value === null) return null;
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new BadRequestException('prompt_sha256 必须是 64 位十六进制字符串');
  }
  return value.toLowerCase();
}

function validateCost(value: string | null): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(value)
  ) {
    throw new BadRequestException(
      'cost_usd 必须是 DECIMAL(12,6) 范围内的十进制字符串',
    );
  }
  return value;
}

function validateAttempt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BadRequestException('attempt_number 必须是正整数');
  }
  return value;
}

function validateWorkflowNode(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 100 ||
    !/^[A-Za-z0-9._:/-]+$/.test(value)
  ) {
    throw new BadRequestException('workflow_node 必须是安全标识符');
  }
  return value;
}

function validateAttemptKind(value: unknown): ModelAttemptKind | 'legacy' {
  if (
    value !== 'initial' &&
    value !== 'network_retry' &&
    value !== 'repair' &&
    value !== 'legacy'
  ) {
    throw new BadRequestException('attempt_kind 无效');
  }
  return value;
}

function validateNonNegativeAttempt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException(`${field} 必须是非负整数`);
  }
  return value;
}

function validateLatency(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new BadRequestException('latency_ms 必须是有效的非负整数');
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertFiniteRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`${field} 必须是有限数字`);
  }
  if (value < min || value > max) {
    throw new BadRequestException(`${field} 超出允许范围`);
  }
}

function assertPositiveInteger(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new BadRequestException(`${field} 必须是正整数`);
  }
}

function assertNonNegativeInteger(
  value: unknown,
  field: string,
  required = false,
): void {
  if (value === undefined) {
    if (required) throw new BadRequestException(`${field} 为必填字段`);
    return;
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new BadRequestException(`${field} 必须是非负整数`);
  }
}

function assertOptionalIdentifier(
  value: unknown,
  field: string,
  maxBytes: number,
): void {
  if (value === undefined) return;
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    !SAFE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new BadRequestException(
      `${field} 必须是最多 ${maxBytes} 字节的安全标识符`,
    );
  }
}

function readAllocatedAttempt(rows: unknown): number {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new BadRequestException('无法分配模型运行序号');
  }
  const raw = (rows[0] as { nextAttempt?: unknown }).nextAttempt;
  const attempt = typeof raw === 'string' ? Number(raw) : raw;
  return validateAttempt(attempt as number);
}

function isIdenticalTerminal(
  existing: ModelRun,
  input: FinishModelRunInput,
): boolean {
  return (
    existing.status === input.status &&
    isEqualUsage(existing.usage, input.usage) &&
    existing.cost_usd === input.cost_usd &&
    existing.error_code === input.error_code &&
    existing.error_message === input.error_message &&
    existing.latency_ms === input.latency_ms
  );
}

function isEqualUsage(
  left: ModelRunUsage | null,
  right: ModelRunUsage | null,
): boolean {
  if (left === null || right === null) return left === right;
  return [...USAGE_KEYS].every((key) => left[key] === right[key]);
}
