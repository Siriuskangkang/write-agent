# Atomic grounding safe rollback

Migration `1713330000000-AddAtomicGroundingContracts` is an additive safety
boundary and must remain applied during application rollback.

The minimum allowed rollback target must advertise this exact capability:

```text
legacy-grounding-fail-closed.v1
```

A binary that does not export or announce
`legacy-grounding-fail-closed.v1` (or a newer compatible capability) is not a
safe rollback target, even if an operator attempted a schema rollback.

## Rollback procedure

1. Leave migration `1713330000000` recorded as applied.
2. Set atomic grounding mode to `off`.
3. Deploy only a binary advertising
   `legacy-grounding-fail-closed.v1` or newer.
4. Verify legacy writes receive `contract_version='legacy:v0'`.
5. Verify public reads cap legacy, missing, malformed, or unknown grounding
   contracts to `UNVERIFIABLE`, score `0`, method `legacy_unverifiable`.
6. Verify strict legacy generation cannot return `ALLOW`.

Do not drop, rename, null out, or rewrite `grounding_assignments.contract_version`.
Do not drop or rewrite `grounding_claims.atomic_claim`. Historical claim rows
must not be upgraded by manufacturing atomic JSON.

The migration intentionally rejects `down()` with
`ATOMIC_GROUNDING_DESTRUCTIVE_ROLLBACK_FORBIDDEN`. Treat that rejection as a
safety control, not as an operational error to bypass.
