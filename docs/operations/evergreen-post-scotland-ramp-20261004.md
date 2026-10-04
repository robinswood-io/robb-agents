# French campaign ramp after Scotland — 4 October 2026

The user authorizes 20–30 daily effects for the combined French press, SME and mid-market campaigns after Scotland's outbound phase closes. The sender-wide ceiling remains 40/day, 200/week, six in a rolling hour and ten minutes between actual Gmail effects.

The engine rereads and verifies the current Scottish contract and its read-only effect ledger. An early schedule pause is not completion. Expiry is the day after the currently authorized last outbound date in Europe/London. Missing, altered or unresolved evidence prevents the increase; complaints and delivery failures also prevent it.

With the current last outbound date of 13 October, the first French window is 14 October at 09:00 Europe/Paris, conditional on reconciliation and fresh eligible contacts. Initial portfolio capacity is 20/day, 100/week (press 4, SME 10, mid-market 6). Capacity becomes 30/day, 150/week (6, 15, 9) after five completed weekday cohorts of at least ten verified effects each, with no new-cohort adverse signals. Earliest conditional date is 21 October. Silence or merely waiting five days cannot unlock 30.

Initial contacts, original-thread replies and followups consume the same daily and weekly capacities. The existing lock serializes French dispatch and the sender guard serializes actual Gmail effects across all campaigns. Current proof freshness, historical exclusions, exact recipient and thread checks, suppression, learning attribution and single-write reconciliation remain unchanged. Recovered bounced lanes stay at one/day and complaints never automatically reopen. Qualified inventory controls actual volume; this is capacity, not a promise to reach 30 daily messages.

## Deployment and evidence

Development server: 164.132.161.150, Git root /srv/workspace/robinswood-agents. Dedicated worktree /opt/ia-webdev/agent-dev/worktrees/robinswood-agents/evergreen-post-scotland-ramp-20261004, branch codex/evergreen-post-scotland-ramp-20261004, based on e96a26b3910364af95786b0afe81ce72f5e7dc5b. The native executor is on 146.59.230.253:/srv/rbw-agents-oss. User-facing target: https://orion.rbw.ovh. The unrelated DEV UI integration /opt/ia-webdev/agent-dev/integration/orion mounted at /app is not changed; this task's DEV runtime is the isolated offline Python/Gmail fixture suite.

Apply source and policy atomically with compare-and-swap and archived previous versions. Reverify native policy digest, exact deployed hashes, current low cadence, read-only conditional future capacity, unpaused native schedules and worker identity. Record results in post-scotland-ramp-activation.json and preserve existing activation history. Never change infrastructures or restart services. GitHub protected reviews and the existing stacked PR dependencies still apply.

Validation: 13 additional ramp tests, including complete isolated Gmail dispatch sequences of 20 and 30 effects, predecessor expiry and current contract, unresolved effects, adverse signals, all-lane reply/followup counting, completed healthy cohorts, Paris daily/weekly reset and recovery canary. Run the existing Scottish, cadence, GET-retry and evergreen regressions. Future fixtures do not alter live time, ledgers or recipients.
