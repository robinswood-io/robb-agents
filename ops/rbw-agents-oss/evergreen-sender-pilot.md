# French two-sender pilot — approved 4 October 2026

The same Gmail account owns thibault@robinswood.io and robb@robinswood.io.
All SENT messages, including manual sends and other aliases, consume the shared
40/day, 200/week, six/rolling hour and 600-second minimum interval limits.
Robb is allowed only for French SME/ETI prospecting, with its verified sendAs
identity, actual signature, Reply-To and explicit AI assistant disclosure.

After the verified Scottish end, the existing 20/day ramp allocates four press
effects to Thibault and eight prospecting effects to each sender (five SME,
three ETI). After five completed healthy weekdays, the 30/day target allocates
ten press effects to Thibault and ten prospecting effects to each sender (six
SME, four ETI). Replies and followups consume these budgets. Before the ramp,
existing lane canaries and recovery restrictions remain authoritative.

New company assignments balance each lane, use hashed ties, and are persisted
before any effect. A refused preflight retains that assignment. Existing
conversations recover their actual sender from the stored MIME payload and
retain their original subject, operation and thread. Each subsequent effect
requires fresh verification of the original SENT message. No new identity
replays historical contacts or changes a held reservation.

The additive sender_bindings migration snapshots the committed SQLite database
before adding the table; the touches table and original INSERT shape stay
compatible. Sender strategy 2026-10-04.1 isolates the Robb disclosure from the
approved base copy 2026-10-02.2. Learning compares qualified results only within
sender/strategy/copy cohorts. Aggregate campaign maturity can still govern
existing lane limits, but cannot select a pooled winning variant or infer a
meeting from a send, open, download or positive reply.

Validation on DEV (no live credentials or recipients):
python3 -m unittest scotland_executive_conference_october_tests   scotland_gateway_read_retry_tests scotland_daily40_tests   robinswood_evergreen_france_tests evergreen_sender_pilot_tests

Native deployment uses archived atomic file replacement, dependencies and code
first, approved contract last, and no worker/service restart. All new writes are
conditioned on a current primary-source-qualified contact and current quotas.
A Sunday dry run proves configuration and identity preparation, not an actual
customer send or inbox delivery. GitHub promotion remains subject to the normal
protected review process.
