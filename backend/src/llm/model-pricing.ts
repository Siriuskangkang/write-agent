import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ModelRun } from '../workflow/entities/model-run.entity.js';
import type {
  FinishModelRunInput,
  StartModelRunInput,
} from '../workflow/model-run.service.js';
import type { ModelOperationMatchIdentity, ModelUsage } from './model-types.js';

interface ModelPrice {
  input_per_million_usd: string;
  output_per_million_usd: string;
  cached_input_per_million_usd?: string;
}

type PricingConfiguration = Record<string, Record<string, ModelPrice>>;

export interface ModelRunRecorder {
  startAttempt(input: StartModelRunInput): Promise<Pick<ModelRun, 'id'>>;
  finishAttempt(id: string, input: FinishModelRunInput): Promise<void>;
  findOperationState?(
    workflowJobId: string,
    operationKey: string,
    expected?: ModelOperationMatchIdentity,
  ): Promise<'absent' | 'recorded' | 'mismatch'>;
}

@Injectable()
export class ModelPricingCatalog {
  private readonly prices: PricingConfiguration;

  constructor(config: ConfigService) {
    this.prices = parsePricing(config.get<string>('MODEL_PRICING_JSON', '{}'));
  }

  calculate(
    provider: string,
    model: string,
    usage: ModelUsage | null,
  ): string | null {
    if (!usage) return null;
    const price = this.prices[provider]?.[model];
    if (!price) return null;

    const cachedTokens =
      price.cached_input_per_million_usd !== undefined
        ? Math.min(usage.cached_input_tokens ?? 0, usage.input_tokens)
        : 0;
    let scaledMicroUsd =
      BigInt(usage.input_tokens - cachedTokens) *
        parsePrice(price.input_per_million_usd) +
      BigInt(usage.output_tokens) * parsePrice(price.output_per_million_usd);
    if (cachedTokens > 0 && price.cached_input_per_million_usd !== undefined) {
      scaledMicroUsd +=
        BigInt(cachedTokens) * parsePrice(price.cached_input_per_million_usd);
    }
    return formatMicroUsd(roundScaledMicroUsd(scaledMicroUsd));
  }
}

function parsePricing(value: string): PricingConfiguration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('MODEL_PRICING_JSON 必须是有效 JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('MODEL_PRICING_JSON 必须是对象');
  }
  const result: PricingConfiguration = {};
  for (const [provider, models] of Object.entries(parsed)) {
    if (!isIdentifier(provider) || !isRecord(models)) {
      throw new Error('MODEL_PRICING_JSON provider 配置无效');
    }
    result[provider] = {};
    for (const [model, rawPrice] of Object.entries(models)) {
      if (!isIdentifier(model) || !isRecord(rawPrice)) {
        throw new Error('MODEL_PRICING_JSON model 配置无效');
      }
      const input = readDecimal(rawPrice, 'input_per_million_usd');
      const output = readDecimal(rawPrice, 'output_per_million_usd');
      const cached =
        rawPrice.cached_input_per_million_usd === undefined
          ? undefined
          : readDecimal(rawPrice, 'cached_input_per_million_usd');
      result[provider][model] = {
        input_per_million_usd: input,
        output_per_million_usd: output,
        ...(cached ? { cached_input_per_million_usd: cached } : {}),
      };
    }
  }
  return result;
}

function readDecimal(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (
    typeof raw !== 'string' ||
    !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(raw)
  ) {
    throw new Error(`MODEL_PRICING_JSON ${key} 必须是非负十进制字符串`);
  }
  return raw;
}

function parsePrice(decimal: string): bigint {
  const [whole, fraction = ''] = decimal.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

/**
 * Token count multiplied by USD-per-million equals micro-USD. Prices retain
 * six fractional digits and the aggregate is rounded once.
 */
function roundScaledMicroUsd(value: bigint): bigint {
  return (value * 2n + 1_000_000n) / 2_000_000n;
}

function formatMicroUsd(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: string): boolean {
  return (
    value.length > 0 && value.length <= 100 && /^[A-Za-z0-9._:/-]+$/.test(value)
  );
}
