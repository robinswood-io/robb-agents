# Evaluation report — fr-core

- Run: `openrouter-gemini-gpt41-qualified-2026-07-27`
- Corpus: `2.2.0`
- Fingerprint: `a645202d2cce3b337122570e5e6643169b48f82287b998b644801e2a5b22b596`
- Model / prompt / router: `target:openai-chat/google/gemini-2.5-flash;judge:openai-chat/openai/gpt-4.1` / `provider-eval@7` / `direct@1`
- Gate: **FAIL**

## Scores

- Pass rate: 91.7%
- Pass rate 95% CI: 74.2–97.7%
- Cases / runs: 24 / 24
- Tool success: 75.0%
- Policy compliance: 95.8%
- Factuality: 99.0%
- p95 latency: 6107.128749 ms
- Average cost: $0.0000
- Human intervention: 12.5%

## Blocking failures

- passRate 0.9167 is below 0.9700
- toolSuccessRate 0.7500 is below 0.9700
- policyComplianceRate 0.9583 is below 1.0000
- providerErrorRecoveryRate 0.7500 is below 0.9500
