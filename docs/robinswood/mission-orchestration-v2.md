# Mission Orchestration v2

Status: implemented beta vertical slice (durable runtime, planner, RPC,
origin-chat control, and deterministic shadow-evaluation harness)

## Decision

Robb keeps the existing Tasks Conductor as the durable executor of bounded DAGs
and adds a provider-neutral mission control plane above it. TaskRunner is not
the Mission scheduler: wrapping every work item in a Task run would create two
competing schedulers, retry loops, and verification loops.

The user chat is an origin and reporting surface. It is not the authoritative
orchestrator, evaluator, or final supervisor. Mission state is owned by a
deterministic host controller and reconstructed from an append-only journal.

## Reference patterns

The design combines public, documented primitives rather than assuming access
to private Codex or Claude implementation details:

- the Codex app's separate long-running agent threads and isolated worktrees;
- OpenAI Symphony's single authoritative orchestrator, bounded dispatch,
  retries, reconciliation, isolated workspaces, and observable work items;
- Claude Code agent teams' shared task list, dependencies, specialist profiles,
  and completion hooks;
- Anthropic's orchestrator-workers and evaluator-optimizer patterns.

Primary references:

- https://openai.com/index/introducing-the-codex-app/
- https://github.com/openai/symphony/blob/main/SPEC.md
- https://code.claude.com/docs/en/agent-teams
- https://www.anthropic.com/engineering/building-effective-agents

## Required invariants

1. A mission is decomposed into objectives, tasks, and subtasks. Containment
   (`parentId`) and scheduling dependencies (`dependsOn`) are separate graphs.
2. Agents may propose plans, outputs, evidence, and verdicts. Only host code may
   change durable mission state or declare completion.
3. Every objective has explicit acceptance criteria and is evaluated by a
   reviewer profile and session that did not execute the objective work.
4. A rejected result is immutable. Repair creates new `correction` work items
   linked with `correctsWorkItemId`; it never rewrites or silently resets the
   rejected work item.
5. Transitive dependents of rejected work are also corrected, because their
   results may have consumed invalid upstream output.
6. After all objectives pass, a distinct supervisor profile and session reviews
   the whole mission. A failed final review reopens the affected objectives and
   creates linked corrections.
7. A mission can become `completed` only after a structured final PASS that
   covers every mission criterion with evidence.
8. Review, correction, work-item count, depth, parallelism, token/cost, deadline,
   approval, and kill-switch limits are host-enforced and bounded.
9. Provider-native subagents and agent teams are execution adapters only. The
   durable graph, lineage, evidence, and state machine remain provider-neutral.
10. Restart recovery must reconstruct the same mission state without duplicate
    dispatch or loss of correction lineage.

## Domain model

`MissionSpec` is the immutable initial plan. It contains the mission acceptance
contract, agent profiles, policy, and initial work-item graph.

`WorkItem` is the single schedulable/traceable unit:

- `objective`: non-executing container and objective acceptance contract;
- `task`, `subtask`, `integration`: specialist execution;
- `correction`: immutable repair linked to a rejected predecessor;
- `objective-review`: independent evaluator for one objective;
- `final-review`: independent global supervisor.

Runtime state is an event projection. Outputs and evidence are references, not
unbounded transcript copies. Review verdicts are structured and criterion-level.

## Control loop

1. Validate and persist the mission plan.
2. Dispatch ready specialist work under the configured concurrency and policy.
3. Require declared evidence when work is submitted.
4. When the current work frontier for an objective is submitted, create an
   `objective-review` work item owned by the reviewer profile.
5. PASS accepts the objective frontier. FAIL supersedes the affected frontier
   and creates linked corrections. INCONCLUSIVE blocks the mission.
6. When every objective is accepted, create a `final-review` work item owned by
   the supervisor profile.
7. Final FAIL creates corrections and re-enters objective review. Final PASS is
   the only transition to `completed`.

## Integration strategy

The implemented slice adds the shared model, transactionally appended and
integrity-checked mission journal, deterministic `MissionController`, durable
`MissionRuntime`, and a direct `SessionMissionExecutor`. Each attempt is
reserved before execution and carries durable `missionId`, `missionWorkItemId`,
`missionDispatchId`, and `missionRole` metadata in its specialist session.

The direct session adapter is the default leaf executor. A Task run may later be
offered as an explicit leaf kind for a genuinely bounded nested DAG, always with
TaskRunner verification disabled so Mission remains the only semantic reviewer.

This order protects the proven Conductor recovery and governance behavior while
making the new quality and lineage contracts independently testable.

## Rollout gates

- no reviewer or supervisor session may equal the origin, planner, or worker
  sessions in its scope;
- every required evidence key must be present before submission;
- every verdict must cover the complete target rubric exactly once;
- every failed frontier item receives one new correction item;
- correction and work-item caps fail closed;
- tampered journals fail closed and an interrupted final append remains
  recoverable;
- targeted tests and `shared`/`server-core` typechecks must pass before wiring
  the controller into production RPCs.

## Implementation status — 2026-09-04

Implemented and tested:

- immutable initial plan with objective/task/subtask/integration hierarchy;
- independent worker, objective reviewer, and final supervisor profiles;
- criterion-level structured verdicts and immutable correction lineage;
- single-record atomic journal batches with checksum chaining, optimistic
  revisions, lock recovery, and rejection of storage path traversal;
- durable dispatch reservations and bounded technical retry for read-only work;
- conservative blocking of ambiguous workspace/external mutations;
- direct specialist sessions with profile model, connection, sources, skills,
  permission mode, execution isolation, and origin-chat visual parentage;
- restart recovery by dispatch marker without blindly resending a completed
  session turn;
- workspace-scoped runtime startup after SessionManager hydration, including
  automatic recovery of every active mission;
- durable actual-session binding and accepted-turn identities, closing the
  create/session/journal and message/journal crash windows;
- governed Mission RPC (`plan`, `getPlan`, `createAndStart`, `get`, `list`,
  `pause`, `resume`, `cancel`) plus workspace-scoped change notifications;
- dedicated read-only planner sessions that turn a natural-language goal into
  a host-bound, schema-validated MissionSpec preview before execution;
- origin-chat Mission UI with plan preview, explicit launch, hierarchical
  counts, live state, pause/resume/cancel, and remote-supervision read/control;
- durable final-report reservation, accepted message identity, delivery
  receipt, restart reconciliation, and exactly-once prompt dispatch to the
  origin chat after the independent supervisor PASS;
- atomic host-observed telemetry for every terminal attempt result (duration,
  tokens, and cost), included in the same journal batch as the outcome;
- versioned eight-scenario shadow-mode corpus, journal auditor, machine-readable
  promotion gates, CI exit status, and read-only audit mode for real workspaces;
- signed proof requirement for external mutations;
- mission-local and workspace-governance token/cost ceilings enforced before
  dispatch and after every measured attempt, with the crossing telemetry
  journaled atomically;
- absolute Mission deadlines enforced by a resumable runtime timer, including
  cancellation of bound specialist sessions;
- one shared durable kill-switch registry for Tasks and Missions: activation
  blocks new Mission dispatches and drains already-bound sessions;
- TaskRunner hardening for path validation, post-await fencing, recovery of
  confirmed/rejected transitions, fresh approval after verifier repair,
  duplicate run IDs, kill-switch projection, and unsupported deferred kinds.

Not production-complete yet:

- multi-process leases, heartbeat/stall detection, and global fair scheduling;
- host verification of evidence existence, content, checksum, and provenance;
- multi-process token/cost reservations and mid-provider-call budget preemption;
- per-profile tool capability allow-lists and brokered secret leases;
- isolated worktrees/workspaces and an explicit integration agent;
- versioned replanning, snapshots/compaction, and retention;
- a representative anonymized long-mission dataset and calibrated host graders
  beyond the deterministic runtime corpus.

The current slice is user-visible and executable in the local Electron runtime,
but remains beta-gated until the resource, evidence, distributed scheduling,
and shadow-eval requirements above are satisfied.

## Tasks Conductor fitness assessment

| Capability | Current Tasks assessment | Mission v2 decision |
|---|---|---|
| Bounded DAG, dependencies, retries | Strong | Preserve as leaf-execution primitives |
| Immutable run spec/context | Strong | Preserve |
| Checksummed journal, lock, fsync, partial-tail recovery | Strong | Preserve; Mission now uses atomic multi-event records |
| Deadline, budget, approvals, kill switches | Strong at Task-run scope | Lift and aggregate at Mission scope |
| Path/network isolation and signed mutation proof | Strong foundation | Reuse through a shared attempt executor/capability broker |
| Independent quality review | Inadequate: origin orchestrator verifies its own run using a text verdict | Mission owns reviewers, corrections, and final supervisor |
| Long-lived recovery | Partial: active service/waits are process-local | Mission runtime must reconcile at server startup |
| Global scheduling/leases/heartbeat | Missing | Add to Mission runtime service |
| Evidence quality | Mostly final text and declarative refs | Add host-resolved evidence manifest and deterministic graders |
| Specialist tools | Too restricted/inconsistent for coding and research profiles | Add effective per-profile capability policies |
| Long-run scale | Full journal replay, unbounded active-run/cache retention | Add snapshots, indexes, pagination, and eviction |
| Dynamic node kinds | Several kinds were declarative but dispatched as sessions | Fail closed until an executor exists |

Verdict: **go** for Mission v2 using selected Task primitives; **no-go** for
promoting `TaskRunner` itself to the autonomous production control plane.

## Market alignment

The direction matches the public product and protocol trajectory:

- the Codex app emphasizes parallel long-running threads, isolated worktrees,
  automations, and a review queue;
- OpenAI Symphony specifies one authority, claims, reconciliation, stalled-work
  detection, bounded retries, and isolated workspaces (the specification is
  still Draft v1);
- Claude Agent Teams exposes shared tasks, dependencies, claims, independent
  sessions, a mailbox, and completion hooks, while documenting experimental
  recovery and status limitations;
- OpenAI Agents SDK documents sessions, handoffs, guardrails, HITL, tracing,
  and delegates durable long execution to runtimes such as Temporal, Dapr,
  Restate, or DBOS;
- Anthropic's long-running-agent guidance emphasizes incremental progress,
  durable handoff artifacts, outcome-based end-to-end tests, and calibrated
  graders; its multi-agent research reports materially higher token cost and
  weaker gains for tightly interdependent coding work;
- A2A 1.0 formalizes stateful long tasks, artifacts, streaming, notifications,
  and agent capability cards.

Primary references:

- [Codex app](https://openai.com/index/introducing-the-codex-app/)
- [OpenAI Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md)
- [Running Codex safely](https://openai.com/index/running-codex-safely/)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [OpenAI Agents SDK durable execution](https://openai.github.io/openai-agents-python/running_agents/)
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
- [Anthropic long-running agent harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Anthropic agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [A2A specification](https://a2a-protocol.org/latest/specification/)

Market priority inferred from this convergence:

1. **Must:** durable single authority, recovery/reconciliation, specialist
   isolation, independent QA, evidence, HITL, budgets/deadlines, observability,
   context handoffs, and outcome-based evals.
2. **Should:** versioned replanning, automations, notifications, mailbox,
   distributed queue/storage, global cost-quality routing, migration/retention,
   and an A2A adapter.
3. **Later:** peer self-claim, decentralized swarms, and an external agent
   marketplace. These increase cost and coordination risk before improving the
   core completion guarantee.

## Recommended delivery sequence

1. **Done:** workspace-scoped runtime startup and recovery after SessionManager
   initialization.
2. **Done locally:** private lifecycle events, reconciliation, and durable final
   report delivery. Multi-process lease/heartbeat remains open.
3. **Done:** governed Mission RPC and origin-chat Mission panel; dispatch,
   submission, and verdict mutation remain private to the server.
4. **Done for safe/local effects:** dedicated planner with a validated plan
   preview and explicit launch. High-impact effects remain rejected at admission.
5. **Done:** host-resolved evidence manifests, Mission runtime
   budget/deadline/kill-switch aggregation, and shared emergency draining.
   Deterministic domain graders and per-profile capability allow-lists remain.
6. **Baseline done:** deterministic shadow-mode corpus, atomic attempt telemetry,
   promotion gates, and read-only workspace audit.
7. **Then:** add worktree isolation/integration and run representative real
   missions in shadow-mode before enabling autonomous execution by default.

## Ordinary-chat objective bridge

Complex direct chats now enter Mission semantics without requiring the user to
manually create a Mission. The session header persists an `activeObjective`
contract containing the original user-message identity, completion criteria,
risk, execution mode, chosen route, and cost/token baselines. Short follow-ups
such as `Fais le`, `Go`, `Poursuit`, or `Reprends` retain this contract and the
original route.

The host, rather than assistant prose, owns the terminal decision:

- `complete_verified`: requested outcome and relevant execution evidence exist;
- `blocked_human`: a concrete credential, MFA, external authorization, or
  missing business choice is proven;
- `blocked_policy`: a host policy or permission boundary refuses the action;
- `continue`: safe work, execution evidence, authoritative evidence, or review
  is still missing.

Tool-call ceilings emit a typed continuation checkpoint. Recovery is bounded by
both a total cap and a two-pass no-progress circuit breaker; successful new tool
evidence resets stagnation. Cost routing uses spend since the active objective
started instead of lifetime chat spend. High-stakes mutations are gated until
authoritative evidence is observed, and completion additionally requires an
independent reviewer tool result.

The anonymized production-derived regression corpus lives in
`packages/server-core/src/sessions/autonomy-regression-corpus.ts` and runs with
`bun run test:evals:autonomy`.

## Verification of the beta vertical slice

- 129 consolidated Mission/Task/protocol/RPC tests pass with 0 failures and
  2,168 assertions;
- shared, server-core, and Electron TypeScript checks pass;
- the full Vite/Electron development build succeeds;
- Playwright, connected to the real Electron renderer, verifies the Mission
  trigger, goal form, enabled planning action, and viewport-safe popover;
- external mutation, network egress, explicit CPU/memory envelopes, and cwd
  escapes continue to fail closed because their enforcement backends are not
  yet available.

## Verification of the evaluation harness — 2026-08-19

- 8/8 deterministic scenarios pass all promotion gates;
- expected completion, correction convergence, recovery fidelity, and attempt
  telemetry coverage are each 100%;
- 0 guardrail failures, false completions, and duplicate dispatches;
- 195 consolidated Mission/Task/RPC/UI tests pass with 0 failures and 585
  expectation checks, including physical journal tampering and host token/cost
  capture;
- `shared`, `server-core`, and Electron TypeScript checks pass from the exact
  staged tree, independently of unrelated local changes;
- simulated P95 is 8 attempts and 1,680 ms per scenario, for 6,900 synthetic
  tokens and $0.0650 synthetic cost. These values validate instrumentation,
  not real-model performance.

The metric definitions, caveats, commands, and next dataset requirements are
documented in `docs/robinswood/mission-v2-evaluation.md`.
