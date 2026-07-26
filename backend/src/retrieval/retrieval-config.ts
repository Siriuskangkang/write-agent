import { createHash } from 'node:crypto';

export interface RetrievalConfigBinding {
  collection_name: string;
  embedding_model: string;
  embedding_dimension: number;
  index_version: string;
  sparse_parser: 'ngram';
  fusion: 'rrf-k60';
  context: 'mmr-source-cap-v1';
}

export function buildRetrievalConfigBinding(input: {
  collection_name: string;
  embedding_model: string;
  embedding_dimension: number;
  index_version: string;
}): RetrievalConfigBinding {
  return {
    collection_name: input.collection_name,
    embedding_model: input.embedding_model,
    embedding_dimension: input.embedding_dimension,
    index_version: input.index_version,
    sparse_parser: 'ngram',
    fusion: 'rrf-k60',
    context: 'mmr-source-cap-v1',
  };
}

export function retrievalConfigHash(binding: RetrievalConfigBinding): string {
  return createHash('sha256').update(JSON.stringify(binding)).digest('hex');
}
