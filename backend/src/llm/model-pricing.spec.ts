import type { ConfigService } from '@nestjs/config';
import { ModelPricingCatalog } from './model-pricing.js';

describe('ModelPricingCatalog', () => {
  it('uses exact decimal arithmetic and does not double-charge cached input', () => {
    const config = {
      get: () =>
        JSON.stringify({
          anthropic: {
            model: {
              input_per_million_usd: '3',
              output_per_million_usd: '15',
              cached_input_per_million_usd: '0.3',
            },
          },
        }),
    } as ConfigService;
    const pricing = new ModelPricingCatalog(config);

    expect(
      pricing.calculate('anthropic', 'model', {
        input_tokens: 1000,
        cached_input_tokens: 400,
        output_tokens: 100,
        total_tokens: 1100,
      }),
    ).toBe('0.003420');
  });

  it('returns null when pricing is intentionally unconfigured', () => {
    const config = {
      get: (_key: string, fallback: string) => fallback,
    } as ConfigService;

    expect(
      new ModelPricingCatalog(config).calculate('fake', 'model', {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      }),
    ).toBeNull();
  });

  it('rounds the aggregate once instead of losing fractional micro-dollars', () => {
    const config = {
      get: () =>
        JSON.stringify({
          fake: {
            model: {
              input_per_million_usd: '0.4',
              output_per_million_usd: '0.4',
            },
          },
        }),
    } as ConfigService;

    expect(
      new ModelPricingCatalog(config).calculate('fake', 'model', {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      }),
    ).toBe('0.000001');
  });
});
