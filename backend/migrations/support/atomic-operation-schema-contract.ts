import type { QueryRunner } from 'typeorm';

const EXPECTED_COLUMNS = new Map([
  [
    'model_runs.operation_key',
    'char(64)|YES|utf8mb4|utf8mb4_0900_ai_ci|prompt_sha256',
  ],
  [
    'model_runs.request_fingerprint',
    'char(64)|YES|utf8mb4|utf8mb4_0900_ai_ci|operation_key',
  ],
  [
    'retrieval_runs.workflow_job_id',
    'varchar(36)|YES|utf8mb4|utf8mb4_0900_ai_ci|project_id',
  ],
  [
    'retrieval_runs.revision_attempt',
    'tinyint unsigned|YES|∅|∅|workflow_job_id',
  ],
  [
    'retrieval_runs.request_sha256',
    'char(64)|YES|utf8mb4|utf8mb4_0900_ai_ci|revision_attempt',
  ],
] as const);
export const ATOMIC_SCOPE_CHECK_EXPRESSION = `(
  (
    workflow_job_id IS NULL
    AND revision_attempt IS NULL
    AND request_sha256 IS NULL
  )
  OR
  (
    workflow_job_id IS NOT NULL
    AND revision_attempt = 1
    AND request_sha256 IS NOT NULL
    AND REGEXP_LIKE(
      request_sha256,
      _ascii'^[0-9a-f]{64}$',
      _ascii'c'
    )
  )
) IS TRUE`;

export async function findAtomicOperationSchemaContractViolations(
  queryRunner: QueryRunner,
): Promise<string[]> {
  const [columns, indexes, foreignKeys, checks] = await Promise.all([
    queryRunner.query(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
              COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
              CHARACTER_SET_NAME AS characterSet,
              COLLATION_NAME AS collation,
              COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
              GENERATION_EXPRESSION AS generationExpression,
              (
                SELECT previous.COLUMN_NAME
                  FROM information_schema.COLUMNS previous
                 WHERE previous.TABLE_SCHEMA = target.TABLE_SCHEMA
                   AND previous.TABLE_NAME = target.TABLE_NAME
                   AND previous.ORDINAL_POSITION =
                       target.ORDINAL_POSITION - 1
              ) AS previousColumn
         FROM information_schema.COLUMNS target
        WHERE target.TABLE_SCHEMA = DATABASE()
          AND (
            (TABLE_NAME = 'model_runs'
             AND COLUMN_NAME IN ('operation_key', 'request_fingerprint'))
            OR
            (TABLE_NAME = 'retrieval_runs'
             AND COLUMN_NAME IN
               ('workflow_job_id', 'revision_attempt', 'request_sha256'))
          )`,
    ) as Promise<unknown>,
    queryRunner.query(
      `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
              NON_UNIQUE AS nonUnique, INDEX_TYPE AS indexType,
              SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName,
              EXPRESSION AS expression, SUB_PART AS subPart,
              IS_VISIBLE AS isVisible, COLLATION AS direction
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND (
            (TABLE_NAME = 'model_runs'
             AND INDEX_NAME = 'uq_model_runs_operation_key')
            OR
            (TABLE_NAME = 'retrieval_runs'
             AND INDEX_NAME = 'uq_retrieval_runs_workflow_revision')
          )
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    ) as Promise<unknown>,
    queryRunner.query(
      `SELECT kcu.TABLE_NAME AS tableName,
              kcu.CONSTRAINT_NAME AS constraintName,
              kcu.COLUMN_NAME AS columnName,
              kcu.ORDINAL_POSITION AS sequenceNumber,
              kcu.POSITION_IN_UNIQUE_CONSTRAINT AS referencedSequenceNumber,
              (kcu.REFERENCED_TABLE_SCHEMA = DATABASE())
                AS referencesCurrentSchema,
              kcu.REFERENCED_TABLE_NAME AS referencedTableName,
              kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,
              rc.DELETE_RULE AS deleteRule, rc.UPDATE_RULE AS updateRule
         FROM information_schema.KEY_COLUMN_USAGE kcu
         JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
          AND rc.TABLE_NAME = kcu.TABLE_NAME
        WHERE kcu.TABLE_SCHEMA = DATABASE()
          AND kcu.CONSTRAINT_NAME =
              'retrieval_runs_workflow_job_id_fkey'`,
    ) as Promise<unknown>,
    queryRunner.query(
      `SELECT tc.TABLE_NAME AS tableName,
              tc.CONSTRAINT_NAME AS constraintName,
              tc.ENFORCED AS enforced, cc.CHECK_CLAUSE AS checkClause
         FROM information_schema.TABLE_CONSTRAINTS tc
         JOIN information_schema.CHECK_CONSTRAINTS cc
           ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
          AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
          AND tc.CONSTRAINT_NAME =
              'chk_retrieval_runs_atomic_revision_scope'
          AND tc.CONSTRAINT_TYPE = 'CHECK'`,
    ) as Promise<unknown>,
  ]);
  if (
    !Array.isArray(columns) ||
    !Array.isArray(indexes) ||
    !Array.isArray(foreignKeys) ||
    !Array.isArray(checks)
  ) {
    return ['atomic operation schema inspection'];
  }

  const violations: string[] = [];
  for (const [key, expected] of EXPECTED_COLUMNS) {
    const [table, column] = key.split('.');
    const row = columns.find(
      (candidate) =>
        read(candidate, 'tableName') === table &&
        read(candidate, 'columnName') === column,
    );
    const signature = row
      ? [
          read(row, 'columnType').toLowerCase(),
          read(row, 'nullable'),
          nullable(row, 'characterSet'),
          nullable(row, 'collation'),
          read(row, 'previousColumn'),
        ].join('|')
      : '';
    if (
      signature !== expected ||
      readUnknown(row, 'defaultValue') !== null ||
      read(row, 'extra') !== '' ||
      read(row, 'generationExpression') !== ''
    ) {
      violations.push(key);
    }
  }

  if (
    !sameIndex(
      indexes.filter((row) => read(row, 'tableName') === 'model_runs'),
      ['operation_key'],
    )
  ) {
    violations.push('model_runs.uq_model_runs_operation_key');
  }
  if (
    !sameIndex(
      indexes.filter((row) => read(row, 'tableName') === 'retrieval_runs'),
      ['workflow_job_id', 'revision_attempt'],
    )
  ) {
    violations.push('retrieval_runs.uq_retrieval_runs_workflow_revision');
  }
  if (
    foreignKeys.length !== 1 ||
    read(foreignKeys[0], 'tableName') !== 'retrieval_runs' ||
    read(foreignKeys[0], 'columnName') !== 'workflow_job_id' ||
    Number(readUnknown(foreignKeys[0], 'sequenceNumber')) !== 1 ||
    Number(readUnknown(foreignKeys[0], 'referencedSequenceNumber')) !== 1 ||
    Number(readUnknown(foreignKeys[0], 'referencesCurrentSchema')) !== 1 ||
    read(foreignKeys[0], 'referencedTableName') !== 'workflow_jobs' ||
    read(foreignKeys[0], 'referencedColumnName') !== 'id' ||
    read(foreignKeys[0], 'deleteRule') !== 'CASCADE' ||
    read(foreignKeys[0], 'updateRule') !== 'RESTRICT'
  ) {
    violations.push('retrieval_runs.retrieval_runs_workflow_job_id_fkey');
  }
  if (
    checks.length !== 1 ||
    read(checks[0], 'tableName') !== 'retrieval_runs' ||
    read(checks[0], 'enforced') !== 'YES' ||
    !isAtomicScopeCheckClause(readUnknown(checks[0], 'checkClause'))
  ) {
    violations.push('retrieval_runs.chk_retrieval_runs_atomic_revision_scope');
  }
  return violations;
}

function sameIndex(
  rows: unknown[],
  expectedColumns: readonly string[],
): boolean {
  return (
    rows.length === expectedColumns.length &&
    rows.every(
      (row, index) =>
        Number(readUnknown(row, 'nonUnique')) === 0 &&
        read(row, 'indexType') === 'BTREE' &&
        Number(readUnknown(row, 'sequenceNumber')) === index + 1 &&
        read(row, 'columnName') === expectedColumns[index] &&
        readUnknown(row, 'expression') === null &&
        readUnknown(row, 'subPart') === null &&
        read(row, 'isVisible') === 'YES' &&
        read(row, 'direction') === 'A',
    )
  );
}

export function isAtomicScopeCheckClause(value: unknown): boolean {
  const candidate = canonicalCheck(value);
  return (
    EXPECTED_CHECK !== null &&
    candidate !== null &&
    candidate === EXPECTED_CHECK
  );
}

type CheckNode =
  | { kind: 'value'; type: 'identifier' | 'number' | 'string'; value: string }
  | { kind: 'call'; name: string; arguments: CheckNode[] }
  | { kind: 'and' | 'or'; operands: CheckNode[] }
  | { kind: 'equals'; left: CheckNode; right: CheckNode }
  | {
      kind: 'is';
      left: CheckNode;
      predicate: 'null' | 'true' | 'false';
      negated: boolean;
    };

interface CheckToken {
  type: 'word' | 'number' | 'string' | 'symbol';
  value: string;
}

function canonicalCheck(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const tokens = tokenizeCheck(value.replaceAll("\\'", "'"));
  if (!tokens) return null;
  const parser = new CheckParser(tokens);
  const parsed = parser.parse();
  return parsed ? JSON.stringify(parsed) : null;
}

function tokenizeCheck(value: string): CheckToken[] | null {
  const tokens: CheckToken[] = [];
  let index = 0;
  while (index < value.length) {
    const character = value[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '`') {
      const quoted = readQuoted(value, index, '`');
      if (!quoted) return null;
      tokens.push({
        type: 'word',
        value: quoted.value.toLowerCase(),
      });
      index = quoted.next;
      continue;
    }
    if (character === "'") {
      const quoted = readQuoted(value, index, "'");
      if (!quoted) return null;
      tokens.push({ type: 'string', value: quoted.value });
      index = quoted.next;
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      let end = index + 1;
      while (end < value.length && /[A-Za-z0-9_$]/u.test(value[end]!)) {
        end += 1;
      }
      const word = value.slice(index, end).toLowerCase();
      if (
        word.startsWith('_') &&
        ['_ascii', '_utf8mb4', '_latin1'].includes(word) &&
        value[end] === "'"
      ) {
        const quoted = readQuoted(value, end, "'");
        if (!quoted) return null;
        tokens.push({ type: 'string', value: quoted.value });
        index = quoted.next;
        continue;
      }
      tokens.push({ type: 'word', value: word });
      index = end;
      continue;
    }
    if (/[0-9]/u.test(character)) {
      let end = index + 1;
      while (end < value.length && /[0-9]/u.test(value[end]!)) end += 1;
      tokens.push({ type: 'number', value: value.slice(index, end) });
      index = end;
      continue;
    }
    if (['(', ')', ',', '='].includes(character)) {
      tokens.push({ type: 'symbol', value: character });
      index += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

function readQuoted(
  value: string,
  start: number,
  quote: "'" | '`',
): { value: string; next: number } | null {
  let result = '';
  let index = start + 1;
  while (index < value.length) {
    const character = value[index]!;
    if (character === quote) {
      if (value[index + 1] === quote) {
        result += quote;
        index += 2;
        continue;
      }
      return { value: result, next: index + 1 };
    }
    result += character;
    index += 1;
  }
  return null;
}

class CheckParser {
  private index = 0;

  constructor(private readonly tokens: readonly CheckToken[]) {}

  parse(): CheckNode | null {
    const node = this.parseOr();
    return node && this.index === this.tokens.length ? node : null;
  }

  private parseOr(): CheckNode | null {
    const first = this.parseAnd();
    if (!first) return null;
    const operands = [first];
    while (this.matchWord('or')) {
      const operand = this.parseAnd();
      if (!operand) return null;
      operands.push(operand);
    }
    return combineLogical('or', operands);
  }

  private parseAnd(): CheckNode | null {
    const first = this.parsePredicate();
    if (!first) return null;
    const operands = [first];
    while (this.matchWord('and')) {
      const operand = this.parsePredicate();
      if (!operand) return null;
      operands.push(operand);
    }
    return combineLogical('and', operands);
  }

  private parsePredicate(): CheckNode | null {
    let left = this.parsePrimary();
    if (!left) return null;
    if (this.matchSymbol('=')) {
      const right = this.parsePrimary();
      if (!right) return null;
      left = { kind: 'equals', left, right };
    }
    if (this.matchWord('is')) {
      const negated = this.matchWord('not');
      const predicate = this.takeWord();
      if (!predicate || !['null', 'true', 'false'].includes(predicate)) {
        return null;
      }
      left = {
        kind: 'is',
        left,
        predicate: predicate as 'null' | 'true' | 'false',
        negated,
      };
    }
    return left;
  }

  private parsePrimary(): CheckNode | null {
    if (this.matchSymbol('(')) {
      const node = this.parseOr();
      return node && this.matchSymbol(')') ? node : null;
    }
    const token = this.tokens[this.index];
    if (!token || token.type === 'symbol') return null;
    this.index += 1;
    if (token.type === 'word' && this.matchSymbol('(')) {
      const arguments_: CheckNode[] = [];
      if (!this.matchSymbol(')')) {
        do {
          const argument = this.parseOr();
          if (!argument) return null;
          arguments_.push(argument);
        } while (this.matchSymbol(','));
        if (!this.matchSymbol(')')) return null;
      }
      return { kind: 'call', name: token.value, arguments: arguments_ };
    }
    return {
      kind: 'value',
      type:
        token.type === 'word'
          ? 'identifier'
          : token.type === 'number'
            ? 'number'
            : 'string',
      value: token.value,
    };
  }

  private matchWord(value: string): boolean {
    const token = this.tokens[this.index];
    if (token?.type !== 'word' || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private takeWord(): string | null {
    const token = this.tokens[this.index];
    if (token?.type !== 'word') return null;
    this.index += 1;
    return token.value;
  }

  private matchSymbol(value: string): boolean {
    const token = this.tokens[this.index];
    if (token?.type !== 'symbol' || token.value !== value) return false;
    this.index += 1;
    return true;
  }
}

function combineLogical(kind: 'and' | 'or', operands: CheckNode[]): CheckNode {
  const flattened = operands.flatMap((operand) =>
    operand.kind === kind ? operand.operands : [operand],
  );
  return flattened.length === 1 ? flattened[0]! : { kind, operands: flattened };
}

const EXPECTED_CHECK = canonicalCheck(ATOMIC_SCOPE_CHECK_EXPRESSION);

function read(row: unknown, key: string): string {
  return String(readUnknown(row, key) ?? '');
}

function nullable(row: unknown, key: string): string {
  const value = readUnknown(row, key);
  return value === null || value === undefined ? '∅' : String(value);
}

function readUnknown(row: unknown, key: string): unknown {
  return typeof row === 'object' && row !== null
    ? (row as Record<string, unknown>)[key]
    : undefined;
}
