# Soak Test Baseline

**Generated:** 2026-04-24T10:13:33.676Z
**Duration:** 1 minute(s)
**Sample interval:** 1 minute(s)
**Verdict:** **PASS** (threshold: +50 MB RSS)

## Summary

- Start RSS: **107.56 MB**
- End RSS: **127.02 MB**
- Delta: **+19.46 MB**
- Peak RSS: **127.02 MB**

## Samples

| Timestamp | Elapsed (min) | RSS (MB) | Heap used (MB) |
|-----------|---------------|----------|----------------|
| 2026-04-24T10:12:33.669Z | 0.00 | 107.56 | 8.22 |
| 2026-04-24T10:13:33.674Z | 1.00 | 127.02 | 18.87 |
| 2026-04-24T10:13:33.674Z | 1.00 | 127.02 | 18.87 |

## Notes

- Harness exercises `createServices` with a fake VSCode `ExtensionContext` — no extension host required.
- A `soak cycle` breadcrumb is emitted per iteration; on machines without the composition root available, an allocation loop keeps GC busy.
- Re-run after Phase 03 (Monitor v2 + MetricBus) for regression check.
- This harness is NOT wired into CI by default — run locally or in nightly.
