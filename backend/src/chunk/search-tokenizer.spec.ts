import {
  extractTopSearchTerms,
  tokenizeForSearch,
} from './search-tokenizer.js';

describe('search tokenizer', () => {
  it('tokenizes chinese text into searchable terms', () => {
    const tokens = tokenizeForSearch(
      '人工智能带来了新的教学机会和课程设计方法',
    );

    expect(tokens).toContain('人工');
    expect(tokens).toContain('智能');
    expect(tokens).toContain('教学');
  });

  it('keeps english terms for mixed-language text', () => {
    const tokens = tokenizeForSearch(
      'LLM agent workflow with retrieval and embedding',
    );

    expect(tokens).toContain('llm');
    expect(tokens).toContain('agent');
    expect(tokens).toContain('retrieval');
  });

  it('extracts bounded top search terms', () => {
    const terms = extractTopSearchTerms(
      '人工智能课程设计人工智能教学案例分析',
      10,
    );

    expect(terms.length).toBeLessThanOrEqual(10);
    expect(terms).toContain('人工');
  });
});
