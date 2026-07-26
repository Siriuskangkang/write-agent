const STOP_WORDS = new Set([
  'the',
  'is',
  'at',
  'which',
  'on',
  'and',
  'or',
  'an',
  'be',
  'to',
  'of',
  'in',
  'for',
  'it',
  'this',
  'that',
  'with',
  'as',
  'are',
  'was',
  'from',
  'by',
  'not',
  'but',
  'have',
  'has',
  'had',
  'do',
  'does',
  '的',
  '了',
  '在',
  '是',
  '我',
  '有',
  '和',
  '就',
  '不',
  '人',
  '都',
  '一',
  '一个',
  '上',
  '也',
  '很',
  '到',
  '说',
  '要',
  '去',
  '你',
  '会',
  '着',
  '没有',
  '看',
  '好',
  '自己',
  '这',
]);

function tokenizeChineseSequence(sequence: string): string[] {
  if (sequence.length <= 4) {
    return [sequence];
  }

  const terms: string[] = [];

  for (let size = 2; size <= 3; size++) {
    for (let index = 0; index <= sequence.length - size; index++) {
      terms.push(sequence.slice(index, index + size));
    }
  }

  return terms;
}

export function tokenizeForSearch(text: string): string[] {
  const lowered = text.toLowerCase();
  const asciiTerms = lowered.match(/[a-z0-9]{2,}/g) ?? [];
  const chineseSequences = lowered.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];

  const chineseTerms = chineseSequences.flatMap((sequence) =>
    tokenizeChineseSequence(sequence),
  );

  const merged = [...asciiTerms, ...chineseTerms].filter(
    (term) => !STOP_WORDS.has(term) && term.trim().length >= 2,
  );

  return [...new Set(merged)];
}

export function extractTopSearchTerms(text: string, limit = 20): string[] {
  const freq = new Map<string, number>();

  // 直接在原始文本上统计频率（不去重），保留重复词的频率信息
  const lowered = text.toLowerCase();
  const asciiTerms = lowered.match(/[a-z0-9]{2,}/g) ?? [];
  const chineseSequences = lowered.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const chineseTerms = chineseSequences.flatMap((seq) =>
    tokenizeChineseSequence(seq),
  );

  for (const term of [...asciiTerms, ...chineseTerms]) {
    if (!STOP_WORDS.has(term) && term.trim().length >= 2) {
      freq.set(term, (freq.get(term) || 0) + 1);
    }
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}
