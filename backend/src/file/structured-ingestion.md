# Structured ingestion contract

- `SourceFile.checksum_sha256` is the immutable source identity written after
  upload validation.
- A parse attempt opens the source once, verifies its size and SHA-256, and
  passes that exact byte snapshot to the parser. In-place mutation detected by
  descriptor stats fails closed before ingestion.
- `parse_generation` is advanced with the durable parse outbox event. Worker
  status writes and ingestion activation are fenced by the current generation,
  so an older failure cannot overwrite a newer successful parse.
- A document ingestion version is scoped to one source file and identified by
  `SHA-256(source checksum, parser version, chunk version)`.
- AST offsets are half-open UTF-16 code-unit offsets into the normalized
  `Document.content_text`; they are not byte offsets into the original file.
- PDF locations are pages and PPTX locations are slides. DOCX pagination is
  explicitly degraded because rendered page boundaries are unavailable.
- All parsers share byte/page/slide/block/character/token/time budgets and an
  `AbortSignal`; finalized AST fields and offsets are runtime-validated.
- Reprocessing atomically activates one document/chunk version. Inactive
  versions are retained so citations and audit records remain reproducible.
- Inactive versions are deleted only when their source file or project is
  explicitly deleted. A future retention job must first prove that no citation
  ledger entry references the version.
