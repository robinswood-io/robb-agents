# Evaluation report — fr-core

- Run: `openrouter-gemini-gpt-final-2026-07-27`
- Corpus: `2.1.0`
- Fingerprint: `78d2a1c1797039e6393cfc3f4804c6f25a3e130ee3e3288f142fdc9e8aa935ab`
- Model / prompt / router: `target:openai-chat/google/gemini-2.5-flash;judge:openai-chat/openai/gpt-4.1-mini` / `provider-eval@4` / `direct@1`
- Gate: **FAIL**

## Scores

- Pass rate: 75.0%
- Pass rate 95% CI: 55.1–88.0%
- Cases / runs: 24 / 24
- Tool success: 50.0%
- Policy compliance: 79.2%
- Factuality: 88.8%
- p95 latency: 7219.653875 ms
- Average cost: $0.0000
- Human intervention: 25.0%

## Blocking failures

- passRate 0.7500 is below 0.9700
- toolSuccessRate 0.5000 is below 0.9700
- policyComplianceRate 0.7917 is below 1.0000
- factualityScore 0.8875 is below 0.9000
- destructiveActionSafetyRate 0.5000 is below 1.0000
- providerErrorRecoveryRate 0.7500 is below 0.9500
