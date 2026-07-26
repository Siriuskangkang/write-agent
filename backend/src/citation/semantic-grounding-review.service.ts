import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModelGateway } from '../llm/model-gateway.js';
import type { StructuredOutputSchema } from '../llm/model-types.js';
import type {
  ClaimSupportStatus,
  SemanticGroundingReviewer,
  SemanticGroundingReviewInput,
} from './grounding-verifier.js';

interface SemanticReviewOutput {
  reviews: Array<{
    claim_index: number;
    support_status: ClaimSupportStatus;
    support_score: number;
  }>;
}

const semanticReviewSchema: StructuredOutputSchema<SemanticReviewOutput> = {
  id: 'grounding-semantic-review-v1',
  json_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reviews'],
    properties: {
      reviews: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claim_index', 'support_status', 'support_score'],
          properties: {
            claim_index: { type: 'integer', minimum: 0 },
            support_status: {
              type: 'string',
              enum: ['SUPPORTED', 'PARTIAL', 'UNSUPPORTED', 'UNVERIFIABLE'],
            },
            support_score: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
  },
  parse(value: unknown): SemanticReviewOutput {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('semantic review must be an object');
    }
    const reviews = (value as Record<string, unknown>).reviews;
    if (!Array.isArray(reviews)) {
      throw new Error('semantic review.reviews must be an array');
    }
    const seen = new Set<number>();
    return {
      reviews: reviews.map((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          throw new Error('semantic review item must be an object');
        }
        const record = item as Record<string, unknown>;
        const claimIndex = Number(record.claim_index);
        const supportStatus = record.support_status;
        const supportScore = Number(record.support_score);
        if (!Number.isSafeInteger(claimIndex) || claimIndex < 0) {
          throw new Error('semantic review claim_index is invalid');
        }
        if (seen.has(claimIndex)) {
          throw new Error('semantic review claim_index is duplicated');
        }
        seen.add(claimIndex);
        if (!isSupportStatus(supportStatus)) {
          throw new Error('semantic review support_status is invalid');
        }
        if (
          !Number.isFinite(supportScore) ||
          supportScore < 0 ||
          supportScore > 1
        ) {
          throw new Error('semantic review support_score is invalid');
        }
        return {
          claim_index: claimIndex,
          support_status: supportStatus,
          support_score: supportScore,
        };
      }),
    };
  },
};

@Injectable()
export class SemanticGroundingReviewService implements SemanticGroundingReviewer {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly config: ConfigService,
  ) {}

  async review(
    input: SemanticGroundingReviewInput,
  ): Promise<SemanticReviewOutput['reviews']> {
    const enabled =
      String(
        this.config.get('GROUNDING_SEMANTIC_REVIEW_ENABLED', true),
      ).toLowerCase() !== 'false';
    const maxCostUsd = Number(
      this.config.get('GROUNDING_SEMANTIC_REVIEW_MAX_COST_USD', 0.01),
    );
    if (!enabled || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      return [];
    }
    const configuredMaxTokens = Number(
      this.config.get('GROUNDING_SEMANTIC_REVIEW_MAX_TOKENS', 1_200),
    );
    const maxTokens = Number.isFinite(configuredMaxTokens)
      ? Math.min(1_200, Math.max(200, configuredMaxTokens))
      : 1_200;
    const request = {
      response_mode: 'structured',
      schema: semanticReviewSchema,
      messages: [
        {
          role: 'system',
          content:
            '你是证据支持性审查器。只能判断给定证据是否支持声明；不得引入外部知识。输出严格 JSON。',
        },
        {
          role: 'user',
          content: JSON.stringify(input.claims),
        },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      timeout_ms: 30_000,
      max_retries: 0,
      max_repair_attempts: 0,
      trace: {
        workflow_job_id: input.workflow_job_id,
        node: 'grounding_semantic_review',
        attempt: 1,
      },
    } as const;
    const estimatedCost = this.gateway.estimateWorstCaseCost(request);
    if (
      estimatedCost === null ||
      !isCostWithinBudget(estimatedCost, maxCostUsd)
    ) {
      return [];
    }
    const completion = await this.gateway.complete(request);
    const actualCost = this.gateway.calculateUsageCost(completion.usage);
    if (actualCost === null || !isCostWithinBudget(actualCost, maxCostUsd)) {
      return [];
    }
    return completion.structured_output?.reviews ?? [];
  }
}

function isCostWithinBudget(cost: string, maxCostUsd: number): boolean {
  const parsed = Number(cost);
  return (
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    Number.isFinite(maxCostUsd) &&
    maxCostUsd > 0 &&
    parsed <= maxCostUsd
  );
}

function isSupportStatus(value: unknown): value is ClaimSupportStatus {
  return (
    value === 'SUPPORTED' ||
    value === 'PARTIAL' ||
    value === 'UNSUPPORTED' ||
    value === 'UNVERIFIABLE'
  );
}
