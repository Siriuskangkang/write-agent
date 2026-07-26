# RAG evaluation and activation artifact

The versioned fixture contains only a fixed Chinese textbook corpus and
independent relevance judgments. It deliberately contains no legacy or hybrid
rankings.

`npm run rag:evaluate` ingests the corpus into a deterministic offline
evaluation adapter and executes query planning, sparse retrieval, dense
retrieval, RRF and evidence context selection. The output includes a per-query
trace, measured rankings, latency and cost. This fast baseline cannot authorize
hybrid mode.

Set `RAG_REQUIRE_GATE_PASS=1` in CI when a relevance regression should make the
evaluation command exit non-zero. Without it, the command records a failing
baseline successfully while the runtime gate still denies hybrid activation.

An authorization artifact is produced only by `rag:evaluate:production`.
The command creates an isolated temporary user/project/material corpus in
MySQL, indexes it through the normal dense indexing service, waits for every
index to become `READY`, and runs the same `HybridRetriever` orchestration used
online (rerank, neighbor expansion and context selection). It removes the
temporary Qdrant namespaces and MySQL rows in `finally`.

The offline command never writes authorization artifacts. Run the production
harness with a migrated temporary/test database and Qdrant; never point this
command at an unreviewed database:

```bash
RAG_CODE_COMMIT="$(git rev-parse HEAD)" \
RAG_EVALUATION_HMAC_SECRET="<at-least-32-random-characters>" \
npm run rag:evaluate:production -- \
  evaluation/rag/fixtures/chinese-textbook-shadow-v1.json \
  evaluation/rag/artifacts/active.json
```

The command prints the artifact SHA-256, dataset digest and retrieval config
hash. Configure those exact values at runtime. The gate independently verifies
the HMAC, regular-file path, digest, dataset, code commit, index/collection,
embedding model and dimension, config hash, sample count, positive relevance
judgment count, expiry, relevance and the current latency budget. Every trace
must contain at least one relevant corpus chunk. Set
`RAG_EVALUATION_MIN_POSITIVE_JUDGMENTS` to the minimum aggregate number of
independently labeled positive chunk judgments required for activation. Fields
inside the report do not self-authorize.

Artifacts are ignored by Git and mounted read-only at
`/app/evaluation/rag/artifacts` in Docker. The repository therefore contains no
pre-authorized perfect report.
