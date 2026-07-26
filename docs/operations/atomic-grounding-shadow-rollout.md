# Atomic Grounding Shadow 发布

当前实现只支持 `off` 和 `shadow_no_persist`，默认值是 `off`。
Shadow 模式会验证并渲染 atomic candidate，但不会将候选持久化到
writing、version、claim、citation 或 workflow-domain-commit 表。
正式 Atomic 内容持久化不属于当前发布范围。

## Metrics scrape target

Atomic generation runs in the separate worker process, so its in-memory
exporter is exposed by that process rather than by the API process. Scrape
`GET http://127.0.0.1:9465/metrics` for PM2 deployments. Configure
`ATOMIC_GROUNDING_METRICS_HOST` and `ATOMIC_GROUNDING_METRICS_PORT` only when
the scraper topology requires a different worker-local bind address. The
listener serves only `/metrics`; application routes are not mounted.

## Cardinality and data-safety rules

Only the following closed, low-cardinality labels are allowed:

- `workflow_type`: `content|rewrite|expand|compress`
- `schema`: `grounded-draft.v1`
- `status`: `draft|material_gap`
- `method`: `atomic_extract_exact|atomic_typed_equivalent|atomic_unsupported|atomic_unverifiable`
- `verdict`: `SUPPORTED|UNSUPPORTED|UNVERIFIABLE`
- `reason`: one value from the closed `ATOMIC_GROUNDING_REASON_CODES` tuple
- `outcome`: `required|sealed|exhausted`

Workflow, project, claim, evidence, retrieval-run, document, file, model-run,
and user IDs are forbidden metric labels and log fields. Prompt, provider
output, draft/output body, claim text, and evidence text are also forbidden
metric labels and log fields. Logs may contain only the same closed dimensions,
numeric observations, and stable public/internal reason codes.

## Copyable aggregate queries

The examples use a five-minute rate window. Dashboard owners may change the
window without adding labels.

Proposal status and rate by schema/workflow type:

```promql
sum by (schema, workflow_type, status) (
  rate(grounding_proposal_total[5m])
)
```

Claim verdict/method rate:

```promql
sum by (workflow_type, verdict, method) (
  rate(grounding_claim_total[5m])
)
```

Fail-closed rate by exact reason:

```promql
sum by (workflow_type, reason) (
  rate(grounding_fail_closed_total[5m])
)
```

Material-gap rate by exact reason:

```promql
sum by (reason) (
  rate(grounding_material_gap_total[5m])
)
```

Revision required/sealed/exhausted rate:

```promql
sum by (outcome) (
  rate(grounding_revision_total[5m])
)
```

Structured repair rate:

```promql
sum by (schema, workflow_type) (
  rate(grounding_structured_repair_total[5m])
)
/
clamp_min(
  sum by (schema, workflow_type) (
    rate(grounding_proposal_total[5m])
  ),
  1e-9
)
```

Proposal-byte p50/p95:

```promql
histogram_quantile(
  0.50,
  sum by (le, schema, workflow_type, status) (
    rate(grounding_proposal_bytes_bucket[5m])
  )
)
```

```promql
histogram_quantile(
  0.95,
  sum by (le, schema, workflow_type, status) (
    rate(grounding_proposal_bytes_bucket[5m])
  )
)
```

Claim-count p50/p95:

```promql
histogram_quantile(
  0.50,
  sum by (le, schema, workflow_type, status) (
    rate(grounding_proposal_claim_count_bucket[5m])
  )
)
```

```promql
histogram_quantile(
  0.95,
  sum by (le, schema, workflow_type, status) (
    rate(grounding_proposal_claim_count_bucket[5m])
  )
)
```

Render-latency p50/p95:

```promql
histogram_quantile(
  0.50,
  sum by (le, workflow_type) (
    rate(grounding_render_latency_ms_bucket[5m])
  )
)
```

```promql
histogram_quantile(
  0.95,
  sum by (le, workflow_type) (
    rate(grounding_render_latency_ms_bucket[5m])
  )
)
```

Time-to-first-rendered-token p50/p95:

```promql
histogram_quantile(
  0.50,
  sum by (le, workflow_type) (
    rate(grounding_time_to_first_rendered_token_ms_bucket[5m])
  )
)
```

```promql
histogram_quantile(
  0.95,
  sum by (le, workflow_type) (
    rate(grounding_time_to_first_rendered_token_ms_bucket[5m])
  )
)
```
