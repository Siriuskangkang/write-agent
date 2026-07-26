import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

export type ClaimSupportStatus =
  | 'SUPPORTED'
  | 'PARTIAL'
  | 'UNSUPPORTED'
  | 'UNVERIFIABLE';

export type GroundingDecision =
  | 'ALLOW'
  | 'ALLOW_WITH_UNSUPPORTED'
  | 'TARGETED_RETRIEVAL_REVISION'
  | 'WAITING_MATERIAL';

export const GROUNDING_SEMANTIC_REVIEWER = Symbol(
  'GROUNDING_SEMANTIC_REVIEWER',
);

export interface SemanticGroundingReviewInput {
  workflow_job_id: string;
  claims: Array<{
    claim_index: number;
    claim_text: string;
    evidence_text: string;
  }>;
}

export interface SemanticGroundingReviewer {
  review(input: SemanticGroundingReviewInput): Promise<
    Array<{
      claim_index: number;
      support_status: ClaimSupportStatus;
      support_score: number;
    }>
  >;
}

export interface AssignedEvidenceSnapshot {
  evidence_id: string;
  chunk_id: string;
  project_id: string;
  file_id: string;
  document_id: string;
  retrieval_run_id: string;
  ingestion_key: string | null;
  content: string;
  exact_span_text: string;
  chunk_char_start: number | null;
  exact_span_document_start: number | null;
  exact_span_document_end: number | null;
  candidate_rank: number;
  scores: {
    sparse: number | null;
    dense: number | null;
    fusion: number;
    rerank: number;
  };
  ranks: {
    sparse: number | null;
    dense: number | null;
    fusion: number;
    rerank: number;
  };
  page_start: number | null;
  page_end: number | null;
  heading_path: string[];
  index_snapshot: Record<string, unknown>;
  evidence_snapshot_digest?: string;
}

export interface VerifiedEvidenceLink extends AssignedEvidenceSnapshot {
  exact_span_chunk_start: number;
  exact_span_chunk_end: number;
}

export interface VerifiedGroundingClaim {
  claim_id: string;
  claim_text: string;
  normalized_claim_text: string;
  output_char_start: number;
  output_char_end: number;
  support_status: ClaimSupportStatus;
  support_score: number;
  verification_method: string;
  links: VerifiedEvidenceLink[];
}

export interface GroundingVerificationInput {
  workflow_job_id: string;
  project_id: string;
  retrieval_run_id: string;
  retrieval_run_refs?: string[];
  output: string;
  evidence: AssignedEvidenceSnapshot[];
  strict: boolean;
  targeted_revision_attempts?: number;
  assignment_snapshot_digest?: string;
}

export interface GroundingVerificationResult {
  workflow_job_id: string;
  project_id: string;
  retrieval_run_id: string;
  retrieval_run_refs?: string[];
  claims: VerifiedGroundingClaim[];
  decision: GroundingDecision;
  assignment_snapshot_digest?: string;
}

interface ParsedClaim {
  claim_text: string;
  evidence_ids: string[];
  marker_visible_offset: number;
}

interface VisibleStatement {
  text: string;
  start: number;
  end: number;
}

interface VisibleOutput {
  text: string;
  markers: ParsedClaim[];
  statements: VisibleStatement[];
}

@Injectable()
export class GroundingVerifier {
  constructor(
    @Optional()
    @Inject(GROUNDING_SEMANTIC_REVIEWER)
    semanticReviewer?: SemanticGroundingReviewer,
  ) {
    void semanticReviewer;
  }

  async verify(
    input: GroundingVerificationInput,
  ): Promise<GroundingVerificationResult> {
    // Keep the public rejection semantics asynchronous while legacy evaluation
    // remains deliberately deterministic and closed to semantic authorization.
    await Promise.resolve();
    const visible = parseVisibleOutput(input.output);
    const evidenceById = new Map(
      input.evidence.map((item) => [item.evidence_id, item]),
    );
    const claims: VerifiedGroundingClaim[] = [];
    const coveredStatementStarts = new Set<number>();

    for (const parsed of visible.markers) {
      const adjacent = visible.statements.filter(
        (statement) =>
          statement.end <= parsed.marker_visible_offset &&
          visible.text.slice(statement.end, parsed.marker_visible_offset).trim()
            .length === 0,
      );
      const statement = adjacent.at(-1);
      if (
        !statement ||
        statement.text !== parsed.claim_text ||
        coveredStatementStarts.has(statement.start)
      ) {
        throw new BadRequestException(
          'claim_evidence 必须紧邻并完整匹配可见声明',
        );
      }
      coveredStatementStarts.add(statement.start);
      const links = parsed.evidence_ids.map((evidenceId) => {
        const assigned = evidenceById.get(evidenceId);
        if (!assigned) {
          throw new BadRequestException(`证据 ${evidenceId} 未分配给本次写作`);
        }
        return validateEvidence(input, assigned);
      });
      const support = deterministicSupport(parsed.claim_text, links);
      claims.push({
        claim_id: stableClaimId(
          input.workflow_job_id,
          parsed.claim_text,
          statement.start,
          statement.end,
        ),
        claim_text: parsed.claim_text,
        normalized_claim_text: normalizeForComparison(parsed.claim_text),
        output_char_start: statement.start,
        output_char_end: statement.end,
        support_status: support.status,
        support_score: support.score,
        verification_method: support.method,
        links,
      });
    }

    for (const statement of visible.statements) {
      if (coveredStatementStarts.has(statement.start)) continue;
      claims.push(unmarkedVisibleClaim(input.workflow_job_id, statement));
    }
    claims.sort(
      (left, right) => left.output_char_start - right.output_char_start,
    );
    const capped = claims.map((claim) => ({
      ...claim,
      support_status: 'UNVERIFIABLE' as const,
      support_score: 0,
      verification_method: 'legacy_unverifiable',
    }));

    const hasInsufficient = input.strict || capped.length > 0;
    const metadata = {
      workflow_job_id: input.workflow_job_id,
      project_id: input.project_id,
      retrieval_run_id: input.retrieval_run_id,
      ...(input.retrieval_run_refs
        ? { retrieval_run_refs: [...input.retrieval_run_refs] }
        : {}),
      ...(input.assignment_snapshot_digest
        ? {
            assignment_snapshot_digest: input.assignment_snapshot_digest,
          }
        : {}),
    };
    if (!hasInsufficient) {
      return { ...metadata, claims: capped, decision: 'ALLOW' };
    }
    if (!input.strict) {
      return {
        ...metadata,
        claims: capped,
        decision: 'ALLOW_WITH_UNSUPPORTED',
      };
    }
    return {
      ...metadata,
      claims: capped,
      decision:
        (input.targeted_revision_attempts ?? 0) < 1
          ? 'TARGETED_RETRIEVAL_REVISION'
          : 'WAITING_MATERIAL',
    };
  }
}

function unmarkedVisibleClaim(
  workflowJobId: string,
  statement: VisibleStatement,
): VerifiedGroundingClaim {
  return {
    claim_id: stableClaimId(
      workflowJobId,
      statement.text,
      statement.start,
      statement.end,
    ),
    claim_text: statement.text,
    normalized_claim_text: normalizeForComparison(statement.text),
    output_char_start: statement.start,
    output_char_end: statement.end,
    support_status: 'UNVERIFIABLE',
    support_score: 0,
    verification_method: 'deterministic_missing_claim_marker',
    links: [],
  };
}

function parseVisibleOutput(output: string): VisibleOutput {
  const markers: ParsedClaim[] = [];
  let text = '';
  let rawCursor = 0;
  const commentExpression = /<!--([\s\S]*?)-->/gu;
  for (const match of output.matchAll(commentExpression)) {
    const rawStart = match.index ?? 0;
    text += output.slice(rawCursor, rawStart);
    const markerPayload = match[1].match(
      /^\s*claim_evidence:\s*(\{[\s\S]*\})\s*$/u,
    );
    if (markerPayload) {
      markers.push({
        ...parseClaimPayload(markerPayload[1]),
        marker_visible_offset: text.length,
      });
    }
    rawCursor = rawStart + match[0].length;
  }
  text += output.slice(rawCursor);
  return { text, markers, statements: extractVisibleStatements(text) };
}

function parseClaimPayload(
  payload: string,
): Omit<ParsedClaim, 'marker_visible_offset'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new BadRequestException('claim_evidence 不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException('claim_evidence 必须是对象');
  }
  const record = parsed as Record<string, unknown>;
  const claimText =
    typeof record.claim_text === 'string' ? record.claim_text.trim() : '';
  const evidenceIds = Array.isArray(record.evidence_ids)
    ? record.evidence_ids.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      )
    : [];
  if (!claimText) {
    throw new BadRequestException('claim_evidence 缺少 claim_text');
  }
  return {
    claim_text: claimText,
    evidence_ids: [...new Set(evidenceIds)],
  };
}

function extractVisibleStatements(text: string): VisibleStatement[] {
  const statements: VisibleStatement[] = [];
  const lines = Array.from(text.matchAll(/[^\r\n]+/gu));
  let fence: { character: '`' | '~'; length: number } | null = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineMatch = lines[lineIndex];
    const rawLine = lineMatch[0];
    const lineStart = lineMatch.index ?? 0;
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) continue;
    const fenceMatch = trimmedLine.match(/^(`{3,}|~{3,})(.*)$/u);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = {
          character: marker[0] as '`' | '~',
          length: marker.length,
        };
        continue;
      }
      if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        fenceMatch[2].trim().length === 0
      ) {
        fence = null;
        continue;
      }
    }
    if (!fence && isStructuralLine(trimmedLine)) continue;
    if (!fence && isTableHeader(lines, lineIndex)) continue;
    let contentOffset = rawLine.indexOf(trimmedLine);
    const prefix = trimmedLine.match(/^(?:[-+*]\s+|\d+[.)、]\s+)/u)?.[0];
    const visibleLine = prefix ? trimmedLine.slice(prefix.length) : trimmedLine;
    contentOffset += prefix?.length ?? 0;
    for (const sentenceMatch of visibleLine.matchAll(
      /[^。！？!?；;]+(?:[。！？!?；;]|$)/gu,
    )) {
      const rawSentence = sentenceMatch[0];
      const statementText = rawSentence.trim();
      if (!statementText || isStructuralLine(statementText)) continue;
      const start =
        lineStart +
        contentOffset +
        (sentenceMatch.index ?? 0) +
        rawSentence.indexOf(statementText);
      statements.push({
        text: statementText,
        start,
        end: start + statementText.length,
      });
    }
  }
  return statements;
}

function isStructuralLine(value: string): boolean {
  return (
    /^#{1,6}(?:\s|$)/u.test(value) ||
    /^(?:---+|\*\*\*+|___+)$/u.test(value) ||
    /^\|?(?:\s*:?-+:?\s*\|)+$/u.test(value)
  );
}

function isTableHeader(lines: RegExpMatchArray[], lineIndex: number): boolean {
  const value = lines[lineIndex][0].trim();
  if (!value.includes('|')) return false;
  for (let next = lineIndex + 1; next < lines.length; next += 1) {
    const nextValue = lines[next][0].trim();
    if (!nextValue) continue;
    return /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(nextValue);
  }
  return false;
}

function validateEvidence(
  input: GroundingVerificationInput,
  evidence: AssignedEvidenceSnapshot,
): VerifiedEvidenceLink {
  if (evidence.project_id !== input.project_id) {
    throw new BadRequestException(
      `证据 ${evidence.evidence_id} 不属于当前项目`,
    );
  }
  const allowedRuns = new Set(
    input.retrieval_run_refs ?? [input.retrieval_run_id],
  );
  if (!allowedRuns.has(input.retrieval_run_id)) {
    throw new BadRequestException('主检索快照不属于证据分配');
  }
  if (!allowedRuns.has(evidence.retrieval_run_id)) {
    throw new BadRequestException(
      `证据 ${evidence.evidence_id} 不属于本次检索`,
    );
  }
  const offsetOwned =
    evidence.chunk_char_start !== null &&
    evidence.exact_span_document_start !== null;
  const relativeStart = offsetOwned
    ? evidence.exact_span_document_start! - evidence.chunk_char_start!
    : evidence.content.indexOf(evidence.exact_span_text);
  if (
    relativeStart < 0 ||
    evidence.exact_span_text.length === 0 ||
    evidence.content.slice(
      relativeStart,
      relativeStart + evidence.exact_span_text.length,
    ) !== evidence.exact_span_text
  ) {
    if (offsetOwned) {
      throw new BadRequestException(
        `证据 ${evidence.evidence_id} 证据偏移不一致`,
      );
    }
    throw new BadRequestException(`证据 ${evidence.evidence_id} 精确片段无效`);
  }
  const relativeEnd = relativeStart + evidence.exact_span_text.length;
  if (evidence.chunk_char_start !== null) {
    const documentStart = evidence.chunk_char_start + relativeStart;
    const documentEnd = evidence.chunk_char_start + relativeEnd;
    if (
      evidence.exact_span_document_start !== documentStart ||
      evidence.exact_span_document_end !== documentEnd
    ) {
      throw new BadRequestException(
        `证据 ${evidence.evidence_id} 证据偏移不一致`,
      );
    }
  } else if (
    evidence.exact_span_document_start !== null ||
    evidence.exact_span_document_end !== null
  ) {
    throw new BadRequestException(
      `证据 ${evidence.evidence_id} 证据偏移不一致`,
    );
  }
  return {
    ...evidence,
    exact_span_chunk_start: relativeStart,
    exact_span_chunk_end: relativeEnd,
  };
}

function deterministicSupport(
  claimText: string,
  evidence: VerifiedEvidenceLink[],
): { status: ClaimSupportStatus; score: number; method: string } {
  if (evidence.length === 0) {
    return {
      status: 'UNVERIFIABLE',
      score: 0,
      method: 'deterministic_no_evidence',
    };
  }
  const evidenceSpans = evidence.map((item) => item.exact_span_text);
  const combined = evidenceSpans.join(' ');
  const normalizedClaim = normalizeForComparison(claimText);
  const normalizedEvidence = normalizeForComparison(combined);
  if (
    normalizeExactComparison(claimText).length > 0 &&
    normalizeExactComparison(combined) === normalizeExactComparison(claimText)
  ) {
    return {
      status: 'SUPPORTED',
      score: 1,
      method: 'deterministic_exact',
    };
  }

  const propositionResult = comparePropositions(claimText, evidenceSpans);
  if (propositionResult === 'SUPPORTED') {
    return {
      status: 'SUPPORTED',
      score: 1,
      method: 'deterministic_proposition_entailment',
    };
  }
  if (propositionResult !== null) {
    return {
      status: 'UNSUPPORTED',
      score: 0,
      method: propositionResult,
    };
  }

  const score = bigramCoverage(normalizedClaim, normalizedEvidence);
  if (score >= 0.35) {
    return {
      status: 'PARTIAL',
      score: roundScore(score),
      method: 'deterministic_lexical',
    };
  }
  return {
    status: 'UNSUPPORTED',
    score: roundScore(score),
    method: 'deterministic_lexical',
  };
}

function normalizeForComparison(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function normalizeExactComparison(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[。！？!?；;，,\s]+/gu, '');
}

interface CanonicalQuantity {
  start: number;
  end: number;
  dimension: string;
  value: number;
  comparator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'approx';
}

function extractQuantities(value: string): CanonicalQuantity[] {
  const normalized = value.normalize('NFKC');
  const quantities: CanonicalQuantity[] = [];
  const occupied: Array<[number, number]> = [];
  const add = (
    start: number,
    end: number,
    number: number | null,
    unit: string,
    comparator: CanonicalQuantity['comparator'] = 'eq',
    multiplier = 1,
  ) => {
    if (
      number === null ||
      !Number.isFinite(number) ||
      occupied.some(([left, right]) => start < right && end > left)
    ) {
      return;
    }
    quantities.push(
      canonicalQuantity(number * multiplier, unit, start, end, comparator),
    );
    occupied.push([start, end]);
  };
  for (const match of normalized.matchAll(
    /(约|大约|近|超过|高于|大于|不少于|至少|不低于|不超过|至多|不高于|低于|小于)?\s*百分之(负?[零〇一二两三四五六七八九十百千万亿点]+|[-+−]?\d+(?:\.\d+)?)\s*(以上|及以上|以下|及以下|左右)?/gu,
  )) {
    const raw = match[2];
    const number = /[\d]/u.test(raw)
      ? Number(raw.replace('−', '-'))
      : parseChineseNumber(raw);
    add(
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
      number,
      '%',
      quantityComparator(
        match[1],
        match[3],
        normalized.slice(
          Math.max(0, (match.index ?? 0) - 16),
          match.index ?? 0,
        ),
      ),
    );
  }

  for (const match of normalized.matchAll(
    /(约|大约|近|超过|高于|大于|不少于|至少|不低于|不超过|至多|不高于|低于|小于)?\s*([-+−]?(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿点]+))\s*年半\s*(以上|及以上|以下|及以下|左右)?/gu,
  )) {
    const raw = match[2];
    const number = /[\d]/u.test(raw)
      ? Number(raw.replace('−', '-'))
      : parseChineseNumber(raw);
    add(
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
      number === null ? null : number + 0.5,
      '年',
      quantityComparator(
        match[1],
        match[3],
        normalized.slice(
          Math.max(0, (match.index ?? 0) - 16),
          match.index ?? 0,
        ),
      ),
    );
  }

  for (const match of normalized.matchAll(/(?:一半|半数)/gu)) {
    const start = match.index ?? 0;
    const localContext = normalized.slice(Math.max(0, start - 12), start);
    if (/(?:完成|比例|占|达到|实现)$/u.test(localContext)) {
      add(start, start + match[0].length, 0.5, '比例');
    }
  }

  const arabic =
    /(约|大约|近|超过|高于|大于|不少于|至少|不低于|不超过|至多|不高于|低于|小于)?\s*([-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(万|亿)?\s*(GWh|MWh|kWh|Wh|兆瓦时|千瓦时|GW|MW|kW|W|兆瓦|千瓦|瓦|吉瓦|百分比|%|比例|个月|年|月|天|日|小时|分钟|秒|元|倍|度)?\s*(以上|及以上|以下|及以下|左右)?/giu;
  for (const match of normalized.matchAll(arabic)) {
    const unit = match[4] ?? '';
    const multiplier =
      match[3] === '亿' ? 100_000_000 : match[3] === '万' ? 10_000 : 1;
    add(
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
      Number(match[2].replaceAll(',', '').replace('−', '-')),
      unit,
      quantityComparator(
        match[1],
        match[5],
        normalized.slice(
          Math.max(0, (match.index ?? 0) - 16),
          match.index ?? 0,
        ),
      ),
      multiplier,
    );
  }

  for (const match of normalized.matchAll(
    /(约|大约|近|超过|高于|大于|不少于|至少|不低于|不超过|至多|不高于|低于|小于)?\s*(负?[零〇一二两三四五六七八九十百千万亿点]+)\s*元\s*(以上|及以上|以下|及以下|左右)?/gu,
  )) {
    add(
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
      parseChineseNumber(match[2]),
      '元',
      quantityComparator(
        match[1],
        match[3],
        normalized.slice(
          Math.max(0, (match.index ?? 0) - 16),
          match.index ?? 0,
        ),
      ),
    );
  }

  const chinese =
    /(约|大约|近|超过|高于|大于|不少于|至少|不低于|不超过|至多|不高于|低于|小于)?\s*(负?[零〇一二两三四五六七八九十百千万亿点]+?)\s*(兆瓦时|千瓦时|兆瓦|千瓦|瓦|吉瓦|百分比|%|比例|个月|年|月|天|日|小时|分钟|秒|倍|度)\s*(以上|及以上|以下|及以下|左右)?/gu;
  for (const match of normalized.matchAll(chinese)) {
    const number = parseChineseNumber(match[2]);
    add(
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
      number,
      match[3],
      quantityComparator(
        match[1],
        match[4],
        normalized.slice(
          Math.max(0, (match.index ?? 0) - 16),
          match.index ?? 0,
        ),
      ),
    );
  }
  return quantities.sort((left, right) => left.start - right.start);
}

function quantityComparator(
  prefix: string | undefined,
  suffix: string | undefined,
  leadingContext = '',
): CanonicalQuantity['comparator'] {
  const contextualPrefix = leadingContext.match(
    /(约等于|约为|大约为|不少于|至少|不低于|不超过|至多|不高于|超过|高于|大于|低于|小于)\s*(?:为|等于)?\s*$/u,
  )?.[1];
  const effectivePrefix = prefix ?? contextualPrefix;
  if (
    effectivePrefix === '不少于' ||
    effectivePrefix === '至少' ||
    effectivePrefix === '不低于' ||
    suffix === '以上' ||
    suffix === '及以上'
  ) {
    return 'gte';
  }
  if (
    effectivePrefix === '超过' ||
    effectivePrefix === '高于' ||
    effectivePrefix === '大于'
  ) {
    return 'gt';
  }
  if (
    effectivePrefix === '不超过' ||
    effectivePrefix === '至多' ||
    effectivePrefix === '不高于' ||
    suffix === '以下' ||
    suffix === '及以下'
  ) {
    return 'lte';
  }
  if (effectivePrefix === '低于' || effectivePrefix === '小于') return 'lt';
  if (
    effectivePrefix === '约' ||
    effectivePrefix === '大约' ||
    effectivePrefix === '近' ||
    effectivePrefix === '约等于' ||
    effectivePrefix === '约为' ||
    effectivePrefix === '大约为' ||
    suffix === '左右'
  ) {
    return 'approx';
  }
  return 'eq';
}

function canonicalQuantity(
  value: number,
  rawUnit: string,
  start: number,
  end: number,
  comparator: CanonicalQuantity['comparator'],
): CanonicalQuantity {
  let unit = rawUnit.toLowerCase();
  let normalizedValue = value;
  const units: Record<string, { dimension: string; factor: number }> = {
    w: { dimension: 'power_w', factor: 1 },
    瓦: { dimension: 'power_w', factor: 1 },
    kw: { dimension: 'power_w', factor: 1_000 },
    千瓦: { dimension: 'power_w', factor: 1_000 },
    mw: { dimension: 'power_w', factor: 1_000_000 },
    兆瓦: { dimension: 'power_w', factor: 1_000_000 },
    gw: { dimension: 'power_w', factor: 1_000_000_000 },
    吉瓦: { dimension: 'power_w', factor: 1_000_000_000 },
    wh: { dimension: 'energy_wh', factor: 1 },
    kwh: { dimension: 'energy_wh', factor: 1_000 },
    千瓦时: { dimension: 'energy_wh', factor: 1_000 },
    mwh: { dimension: 'energy_wh', factor: 1_000_000 },
    兆瓦时: { dimension: 'energy_wh', factor: 1_000_000 },
    gwh: { dimension: 'energy_wh', factor: 1_000_000_000 },
    年: { dimension: 'duration_month', factor: 12 },
    个月: { dimension: 'duration_month', factor: 1 },
    月: { dimension: 'duration_month', factor: 1 },
    天: { dimension: 'duration_second', factor: 86_400 },
    日: { dimension: 'duration_second', factor: 86_400 },
    小时: { dimension: 'duration_second', factor: 3_600 },
    分钟: { dimension: 'duration_second', factor: 60 },
    秒: { dimension: 'duration_second', factor: 1 },
    '%': { dimension: 'ratio', factor: 0.01 },
    百分比: { dimension: 'ratio', factor: 0.01 },
    比例: { dimension: 'ratio', factor: 1 },
    元: { dimension: 'currency_cny', factor: 1 },
    倍: { dimension: 'multiple', factor: 1 },
    度: { dimension: 'temperature_degree', factor: 1 },
  };
  const definition = units[unit] ?? {
    dimension: unit || 'scalar',
    factor: 1,
  };
  normalizedValue *= definition.factor;
  unit = definition.dimension;
  return {
    start,
    end,
    dimension: unit,
    value: Number(normalizedValue.toPrecision(15)),
    comparator,
  };
}

function parseChineseNumber(value: string): number | null {
  const negative = value.startsWith('负');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart, decimalPart] = unsigned.split('点');
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const integer = parseChineseInteger(integerPart, digits);
  if (integer === null) return null;
  let result = integer;
  if (decimalPart !== undefined) {
    let factor = 0.1;
    for (const character of decimalPart) {
      if (!(character in digits)) return null;
      result += digits[character] * factor;
      factor /= 10;
    }
  }
  return negative ? -result : result;
}

function parseChineseInteger(
  value: string,
  digits: Record<string, number>,
): number | null {
  if (!value) return 0;
  const splitLargeUnit = (unit: '亿' | '万', factor: number): number | null => {
    const index = value.indexOf(unit);
    if (index < 0) return null;
    const left = parseChineseInteger(value.slice(0, index), digits);
    const right = parseChineseInteger(value.slice(index + 1), digits);
    if (left === null || right === null) return Number.NaN;
    return (left || 1) * factor + right;
  };
  if (value.includes('亿')) {
    const parsed = splitLargeUnit('亿', 100_000_000);
    return parsed !== null && Number.isFinite(parsed) ? parsed : null;
  }
  if (value.includes('万')) {
    const parsed = splitLargeUnit('万', 10_000);
    return parsed !== null && Number.isFinite(parsed) ? parsed : null;
  }
  if (![...value].some((character) => /[十百千]/u.test(character))) {
    if (![...value].every((character) => character in digits)) return null;
    return Number([...value].map((character) => digits[character]).join(''));
  }
  const smallUnits: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1_000,
  };
  let result = 0;
  let digit: number | null = null;
  for (const character of value) {
    if (character in digits) {
      digit = digits[character];
      continue;
    }
    const unit = smallUnits[character];
    if (!unit) return null;
    result += (digit ?? 1) * unit;
    digit = null;
  }
  return result + (digit ?? 0);
}

function sameDimensionAndValue(
  left: CanonicalQuantity,
  right: CanonicalQuantity,
): boolean {
  if (left.dimension !== right.dimension) return false;
  const scale = Math.max(1, Math.abs(left.value), Math.abs(right.value));
  return Math.abs(left.value - right.value) <= scale * 1e-9;
}

function quantityEntails(
  evidence: CanonicalQuantity,
  claim: CanonicalQuantity,
): boolean {
  if (evidence.dimension !== claim.dimension) return false;
  if (claim.comparator === 'eq') {
    return (
      evidence.comparator === 'eq' && sameDimensionAndValue(evidence, claim)
    );
  }
  if (claim.comparator === 'approx') {
    return (
      (evidence.comparator === 'eq' || evidence.comparator === 'approx') &&
      sameDimensionAndValue(evidence, claim)
    );
  }
  if (claim.comparator === 'gte') {
    return (
      (evidence.comparator === 'eq' && evidence.value >= claim.value) ||
      ((evidence.comparator === 'gte' || evidence.comparator === 'gt') &&
        evidence.value >= claim.value)
    );
  }
  if (claim.comparator === 'gt') {
    return (
      (evidence.comparator === 'eq' && evidence.value > claim.value) ||
      (evidence.comparator === 'gt' && evidence.value >= claim.value) ||
      (evidence.comparator === 'gte' && evidence.value > claim.value)
    );
  }
  if (claim.comparator === 'lte') {
    return (
      (evidence.comparator === 'eq' && evidence.value <= claim.value) ||
      ((evidence.comparator === 'lte' || evidence.comparator === 'lt') &&
        evidence.value <= claim.value)
    );
  }
  return (
    (evidence.comparator === 'eq' && evidence.value < claim.value) ||
    (evidence.comparator === 'lt' && evidence.value <= claim.value) ||
    (evidence.comparator === 'lte' && evidence.value < claim.value)
  );
}

interface Proposition {
  subject: string;
  predicate: string;
  polarity: 0 | 1;
  quantifier: 'plain' | 'all' | 'not_all' | 'none' | 'not_none';
  quantities: CanonicalQuantity[];
  reliable: boolean;
  structured: boolean;
}

type PropositionComparison =
  | 'SUPPORTED'
  | 'deterministic_entity_mismatch'
  | 'deterministic_subject_predicate_mismatch'
  | 'deterministic_negation_mismatch'
  | 'deterministic_quantifier_mismatch'
  | 'deterministic_quantity_mismatch'
  | null;

function comparePropositions(
  claimText: string,
  evidenceSpans: string[],
): PropositionComparison {
  const claims = parsePropositions(claimText);
  const candidates = evidenceSpans.flatMap((span) => parsePropositions(span));
  if (
    claims.length === 0 ||
    candidates.length === 0 ||
    claims.some((item) => !item.reliable) ||
    candidates.every((item) => !item.reliable)
  ) {
    return null;
  }

  let sawSubjectPredicate = false;
  let sawPolarityMismatch = false;
  let sawQuantifierMismatch = false;
  let sawQuantityMismatch = false;
  for (const claim of claims) {
    const related = candidates.filter(
      (candidate) =>
        candidate.reliable &&
        candidate.subject === claim.subject &&
        candidate.predicate === claim.predicate,
    );
    if (related.length === 0) continue;
    sawSubjectPredicate = true;
    const sameQuantifier = related.filter(
      (candidate) => candidate.quantifier === claim.quantifier,
    );
    if (sameQuantifier.length === 0) {
      sawQuantifierMismatch = true;
      continue;
    }
    const samePolarity = sameQuantifier.filter(
      (candidate) => candidate.polarity === claim.polarity,
    );
    if (samePolarity.length === 0) {
      sawPolarityMismatch = true;
      continue;
    }
    const quantityCompatible = samePolarity.some((candidate) =>
      propositionQuantitiesEntail(candidate.quantities, claim.quantities),
    );
    if (!quantityCompatible) {
      sawQuantityMismatch = true;
      continue;
    }
    continue;
  }
  const allSupported = claims.every((claim) =>
    candidates.some(
      (candidate) =>
        candidate.reliable &&
        candidate.subject === claim.subject &&
        candidate.predicate === claim.predicate &&
        candidate.quantifier === claim.quantifier &&
        candidate.polarity === claim.polarity &&
        propositionQuantitiesEntail(candidate.quantities, claim.quantities),
    ),
  );
  if (allSupported) return 'SUPPORTED';
  if (sawQuantityMismatch) return 'deterministic_quantity_mismatch';
  if (sawPolarityMismatch) return 'deterministic_negation_mismatch';
  if (sawQuantifierMismatch) return 'deterministic_quantifier_mismatch';
  if (sawSubjectPredicate) return null;
  if (
    claims.every((item) => item.structured) &&
    claims.some((item) => item.quantities.length > 0)
  ) {
    return 'deterministic_entity_mismatch';
  }
  return null;
}

function propositionQuantitiesEntail(
  evidence: CanonicalQuantity[],
  claim: CanonicalQuantity[],
): boolean {
  if (evidence.length !== claim.length) return false;
  const unused = [...evidence];
  for (const quantity of claim) {
    const index = unused.findIndex((candidate) =>
      quantityEntails(candidate, quantity),
    );
    if (index < 0) return false;
    unused.splice(index, 1);
  }
  return unused.length === 0;
}

function splitPropositions(value: string): string[] {
  return value
    .normalize('NFKC')
    .split(/[，,。！？!?；;\n、]+/u)
    .flatMap(splitCoordinatedPropositions)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitCoordinatedPropositions(value: string): string[] {
  const parts = value.split(
    /(但是|然而|并且|以及|同时|而且|但|而|且|和|与|及|并(?!非))/u,
  );
  if (parts.length === 1) return [value];

  const clauses = parts.filter((_, index) => index % 2 === 0);
  if (
    clauses.length === 0 ||
    clauses.some((clause) => clause.trim().length === 0)
  ) {
    return [value];
  }

  let previous: Proposition | null = null;
  for (const clause of clauses) {
    const proposition = inheritOmittedValuePredicate(
      parseProposition(clause.trim()),
      previous,
    );
    if (!proposition.reliable || !proposition.structured) return [value];
    previous = proposition;
  }

  return clauses;
}

function parsePropositions(value: string): Proposition[] {
  const result: Proposition[] = [];
  let previous: Proposition | null = null;
  for (const segment of splitPropositions(value)) {
    const proposition = inheritOmittedValuePredicate(
      parseProposition(segment),
      previous,
    );
    result.push(proposition);
    if (proposition.reliable && proposition.structured) {
      previous = proposition;
    }
  }
  return result;
}

function inheritOmittedValuePredicate(
  proposition: Proposition,
  previous: Proposition | null,
): Proposition {
  if (
    !proposition.structured &&
    proposition.reliable &&
    proposition.quantities.length === 1 &&
    previous?.reliable &&
    previous.structured &&
    previous.predicate === 'value' &&
    proposition.subject.length > 0
  ) {
    return {
      ...proposition,
      predicate: previous.predicate,
      structured: true,
    };
  }
  return proposition;
}

function parseProposition(value: string): Proposition {
  const quantities = extractQuantities(value);
  let withoutQuantities = value;
  for (const quantity of [...quantities].reverse()) {
    withoutQuantities =
      withoutQuantities.slice(0, quantity.start) +
      ' __Q__ ' +
      withoutQuantities.slice(quantity.end);
  }
  const quantified = extractQuantifier(withoutQuantities);
  const polarity = negationParity(quantified.text) as 0 | 1;
  const semanticWithQuantity = stripNegations(quantified.text)
    .replace(/(?:已经|已|预计|大约|约|近)/gu, '')
    .replace(
      /(?:至少|至多|不少于|不低于|不超过|不高于|超过|高于|大于|低于|小于|约等于)(?=\s*(?:为|等于|__Q__))/gu,
      '',
    )
    .replace(
      /(?:可以|能够|得以|能|可)(?=运行|使用|执行|工作|实现|完成|支持)/gu,
      '',
    );
  const semantic = semanticWithQuantity.replace(/__Q__/gu, ' ');

  const tableCells = semantic
    .split('|')
    .map((item) => normalizeForComparison(item))
    .filter(Boolean);
  if (tableCells.length >= 2 && quantities.length > 0) {
    return {
      subject: tableCells[0],
      predicate: 'value',
      polarity,
      quantifier: quantified.quantifier,
      quantities,
      reliable:
        tableCells[0].length > 0 &&
        quantities.length === 1 &&
        quantified.reliable,
      structured: true,
    };
  }

  const relation =
    semanticWithQuantity.match(
      /^\s*(.+?)\s*(?:约为|达到|达到了|达|为|是|等于|占)\s*(.*?)\s*$/u,
    ) ?? semanticWithQuantity.match(/^\s*(.+?)\s*__Q__\s*(.*?)\s*$/u);
  if (relation) {
    const subject = normalizeForComparison(relation[1]);
    const predicateTail = normalizeForComparison(
      relation[2].replace(/__Q__/gu, ' '),
    );
    return {
      subject,
      predicate: predicateTail ? `value:${predicateTail}` : 'value',
      polarity,
      quantifier: quantified.quantifier,
      quantities: contextualizeQuantities(subject, quantities),
      reliable:
        subject.length > 0 && quantities.length <= 1 && quantified.reliable,
      structured: true,
    };
  }

  const normalized = normalizeForComparison(semantic);
  const action = normalized.match(
    /^(.+?)(运行|使用|执行|工作|实现|完成|支持|增长|下降|提高|降低)(.*)$/u,
  );
  if (action) {
    return {
      subject: action[1],
      predicate: `${action[2]}${action[3]}`,
      polarity,
      quantifier: quantified.quantifier,
      quantities: contextualizeQuantities(action[2], quantities),
      reliable:
        action[1].length > 0 && quantities.length <= 1 && quantified.reliable,
      structured: true,
    };
  }

  const attribute = normalized.match(/^(.+?)(具备|拥有|包括|包含)(.+)$/u);
  if (attribute) {
    return {
      subject: attribute[1],
      predicate: `${attribute[2]}${attribute[3]}`,
      polarity,
      quantifier: quantified.quantifier,
      quantities,
      reliable:
        attribute[1].length > 0 &&
        quantities.length <= 1 &&
        quantified.reliable,
      structured: true,
    };
  }

  return {
    subject: normalized,
    predicate: 'exact',
    polarity,
    quantifier: quantified.quantifier,
    quantities,
    reliable:
      normalized.length > 0 && quantities.length <= 1 && quantified.reliable,
    structured: false,
  };
}

function extractQuantifier(value: string): {
  text: string;
  quantifier: Proposition['quantifier'];
  reliable: boolean;
} {
  const patterns: Array<{
    expression: RegExp;
    quantifier: Proposition['quantifier'];
  }> = [
    {
      expression: /^\s*(?:并非|不是)\s*(?:没有|无)\s*(?:任何)?\s*/u,
      quantifier: 'not_none',
    },
    {
      expression: /^\s*(?:不是|并非)\s*(?:所有|全部)\s*/u,
      quantifier: 'not_all',
    },
    {
      expression: /^\s*(?:没有|无)\s*(?:任何)?\s*/u,
      quantifier: 'none',
    },
    {
      expression: /^\s*(?:所有|全部)\s*/u,
      quantifier: 'all',
    },
  ];
  for (const pattern of patterns) {
    if (!pattern.expression.test(value)) continue;
    const text = value
      .replace(pattern.expression, '')
      .replace(/都(?=\s*[\p{Script=Han}_])/u, '');
    return {
      text,
      quantifier: pattern.quantifier,
      reliable: !/(?:所有|全部|任何|部分|有些|某些)/u.test(text),
    };
  }
  return {
    text: value,
    quantifier: 'plain',
    reliable: !/(?:所有|全部|任何|部分|有些|某些)/u.test(value),
  };
}

function contextualizeQuantities(
  relation: string,
  quantities: CanonicalQuantity[],
): CanonicalQuantity[] {
  if (!/(?:比例|占|完成)/u.test(relation)) return quantities;
  return quantities.map((quantity) =>
    quantity.dimension === 'scalar'
      ? { ...quantity, dimension: 'ratio' }
      : quantity,
  );
}

function negationParity(value: string): number {
  return (
    Array.from(
      value.matchAll(
        /并非|不是|不为|没有|不能|不会|不得|从未|未曾|否认|禁止|不|未|无/gu,
      ),
    ).length % 2
  );
}

function stripNegations(value: string): string {
  return value.replace(
    /并非|不是|不为|没有|不能|不会|不得|从未|未曾|否认|禁止|不|未|无/gu,
    '',
  );
}

function bigramCoverage(claim: string, evidence: string): number {
  if (claim.length === 0) return 0;
  if (claim.length === 1) return evidence.includes(claim) ? 1 : 0;
  const grams = new Set<string>();
  for (let index = 0; index < claim.length - 1; index += 1) {
    grams.add(claim.slice(index, index + 2));
  }
  let matched = 0;
  for (const gram of grams) {
    if (evidence.includes(gram)) matched += 1;
  }
  return matched / grams.size;
}

function roundScore(score: number): number {
  return Math.round(score * 10_000) / 10_000;
}

function stableClaimId(
  workflowJobId: string,
  claimText: string,
  start: number,
  end: number,
): string {
  return createHash('sha256')
    .update(
      `${workflowJobId}\0${normalizeForComparison(claimText)}\0${start}\0${end}`,
    )
    .digest('hex');
}
