export interface RankedItem {
  chunk_id: string;
  score: number;
  [key: string]: unknown;
}

export function rrfMerge(
  list1: RankedItem[],
  list2: RankedItem[],
  topK: number,
  k = 60,
): RankedItem[] {
  const scoreMap = new Map<string, { score: number; item: RankedItem }>();

  for (let i = 0; i < list1.length; i++) {
    const item = list1[i];
    const rrfScore = 1 / (k + i + 1);
    scoreMap.set(item.chunk_id, { score: rrfScore, item });
  }

  for (let i = 0; i < list2.length; i++) {
    const item = list2[i];
    const rrfScore = 1 / (k + i + 1);
    const existing = scoreMap.get(item.chunk_id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(item.chunk_id, { score: rrfScore, item });
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ score, item }) => ({ ...item, score }));
}
