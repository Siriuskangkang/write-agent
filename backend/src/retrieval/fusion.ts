import type { FusedCandidate, RetrievalCandidate } from './types.js';

export function reciprocalRankFusion(
  sparse: RetrievalCandidate[],
  dense: RetrievalCandidate[],
  k = 60,
): FusedCandidate[] {
  const byId = new Map<
    string,
    {
      item: RetrievalCandidate;
      sparseRank: number | null;
      sparseScore: number | null;
      denseRank: number | null;
      denseScore: number | null;
      fusionScore: number;
    }
  >();

  addRankedList(byId, sparse, 'sparse', k);
  addRankedList(byId, dense, 'dense', k);

  return [...byId.values()]
    .sort(
      (a, b) =>
        b.fusionScore - a.fusionScore ||
        a.item.chunk_id.localeCompare(b.item.chunk_id),
    )
    .map((entry, index) => ({
      ...entry.item,
      sparse_rank: entry.sparseRank,
      sparse_score: entry.sparseScore,
      dense_rank: entry.denseRank,
      dense_score: entry.denseScore,
      fusion_score: entry.fusionScore,
      fusion_rank: index + 1,
      rerank_score: entry.fusionScore,
      rerank_rank: index + 1,
    }));
}

function addRankedList(
  target: Map<
    string,
    {
      item: RetrievalCandidate;
      sparseRank: number | null;
      sparseScore: number | null;
      denseRank: number | null;
      denseScore: number | null;
      fusionScore: number;
    }
  >,
  items: RetrievalCandidate[],
  source: 'sparse' | 'dense',
  k: number,
): void {
  items.forEach((item, index) => {
    const rank = index + 1;
    const existing = target.get(item.chunk_id) ?? {
      item,
      sparseRank: null,
      sparseScore: null,
      denseRank: null,
      denseScore: null,
      fusionScore: 0,
    };
    if (source === 'sparse') {
      existing.sparseRank = rank;
      existing.sparseScore = item.source_score;
    } else {
      existing.denseRank = rank;
      existing.denseScore = item.source_score;
      if (!existing.item.embedding && item.embedding) {
        existing.item = { ...existing.item, embedding: item.embedding };
      }
    }
    existing.fusionScore += 1 / (k + rank);
    target.set(item.chunk_id, existing);
  });
}
