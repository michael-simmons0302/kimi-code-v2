# KC Evolve Mode: Comprehensive Implementation TODO

## 0. Completion contract

### 0.1 Required end state

- [ ] `kimi --evolve` starts a fully functional evaluation-guided adaptive coding run.
- [ ] `kimi --evolve --yolo` preserves current yolo permission semantics.
- [ ] `kimi --evolve --auto` preserves current auto permission semantics.
- [ ] `kimi -p "..." --evolve` works in native v2 print mode.
- [ ] `kimi --evolve --session <id>` resumes prior adaptive artifacts and a compatible checkpoint.
- [ ] `kimi --evolve --continue` resumes the most recent workspace session adaptively.
- [ ] Resuming without `--evolve` leaves adaptive artifacts readable but inactive.
- [ ] `--evolve` never silently falls back to ordinary KC.
- [ ] Ordinary v1 and ordinary v2 behavior remain unchanged when `--evolve` is absent.
- [ ] The implementation performs deterministic and stochastic evaluations.
- [ ] The implementation discovers and maintains multi-scale causal rules.
- [ ] The implementation maintains multiple executable world-model candidates.
- [ ] The implementation performs belief-state tree search over evaluations and task actions.
- [ ] The implementation calculates decision-weighted epistemic information gain.
- [ ] The implementation uses entropy-tempered frontier discovery without corrupting the true posterior.
- [ ] The implementation evolves world-model programs at test time.
- [ ] The implementation verifies candidate patches in isolated workspaces.
- [ ] The implementation executes one real consequential action, observes reality, and replans.
- [ ] The implementation persists evidence, beliefs, candidates, conflicts, and checkpoints.
- [ ] The implementation recovers correctly after interruption.
- [ ] The implementation gives a compact final answer supported by direct evidence.
- [ ] No package contains a placeholder implementation for a required subsystem.
- [ ] No supported execution path throws `NOT_IMPLEMENTED` for an Evolve capability.
- [ ] No protected evaluator, permission service, evidence store, split assignment, or promotion gate is mutable by evolved code.

### 0.2 Definition of “completely done”

- [ ] Every new public interface has a concrete production implementation.
- [ ] Every production implementation has direct unit coverage.
- [ ] Every cross-domain integration seam has an integration test.
- [ ] Every user-facing invocation has an end-to-end test.
- [ ] Every persisted format has a protocol version, validator, corruption behavior, and recovery test.
- [ ] Every background service has cancellation, disposal, backpressure, and recovery behavior.
- [ ] Every stochastic algorithm records its seed and estimator metadata.
- [ ] Every final verification claim can be traced to immutable evidence.
- [ ] Every generated manifest is regenerated and committed.
- [ ] Every new package passes import-boundary linting.
- [ ] All ordinary repository checks pass locally.
- [ ] The benchmark and promotion suite passes the locked thresholds.
- [ ] A final source audit finds no unfinished Evolve TODOs, stubs, unsafe fallbacks, or dead configuration.

---

# 1. Establish the implementation baseline

- [ ] Record the starting repository commit in `docs/evolve/implementation-baseline.md`.
- [ ] Record the approved architecture version as `evolve-architecture/1`.
- [ ] Record all protocol versions in one registry:
  - [ ] evidence ledger protocol;
  - [ ] evidence graph protocol;
  - [ ] evaluation specification protocol;
  - [ ] evaluation result protocol;
  - [ ] structural graph protocol;
  - [ ] causal-rule protocol;
  - [ ] world-model module protocol;
  - [ ] search checkpoint protocol;
  - [ ] adaptive prompt protocol;
  - [ ] benchmark manifest protocol.
- [ ] Add an implementation status document that points to this checklist.
- [ ] Add a changeset for every publishable package affected.
- [ ] Do not add GitHub Actions.
- [ ] Use a dedicated implementation branch rather than editing `main` piecemeal.
- [ ] Require each implementation slice to include code, tests, persistence, recovery, and integration before merging it into the implementation branch.

**Done when:** the repository contains one authoritative architecture version, one protocol registry, one implementation checklist, and no competing partial specifications.

---

# 2. Add the CLI activation surface

KC already defines `-y, --yolo` and `--auto`; parsing and conflict validation live in `commands.ts` and `options.ts`. fileciteturn156file0L1-L6 fileciteturn157file0L1-L6

## 2.1 Parse `--evolve`

Modify:

```text id="t7sgar"
apps/kimi-code/src/cli/commands.ts
apps/kimi-code/src/cli/options.ts
apps/kimi-code/src/main.ts
```

- [ ] Add:

```ts id="2z91a9"
.option(
  '--evolve',
  'Enable evaluation-guided test-time adaptation using executable causal models.',
  false,
)
```

- [ ] Add `evolve: boolean` to `CLIOptions`.
- [ ] Parse `raw['evolve'] === true`.
- [ ] Add `evolve: false` to every neutral/default `CLIOptions` object.
- [ ] Add `evolve: false` to `MIGRATE_CLI_OPTIONS`.
- [ ] Include `evolve` in startup telemetry properties.
- [ ] Include `evolve` in diagnostic startup logs.
- [ ] Include `evolve` in any serialized invocation metadata.

## 2.2 Validate combinations

- [ ] Permit `--evolve`.
- [ ] Permit `--evolve --yolo`.
- [ ] Permit `--evolve --auto`.
- [ ] Permit `--evolve --session <id>`.
- [ ] Permit `--evolve --continue`.
- [ ] Permit `--evolve --prompt <prompt>`.
- [ ] Reject `--evolve --plan`.
- [ ] Preserve the existing rejection of `--prompt --yolo`.
- [ ] Preserve the existing rejection of `--prompt --auto`.
- [ ] Add the exact error:

```text id="hjulxx"
Cannot combine --evolve with --plan. Evolve mode performs evaluations and may execute candidate changes.
```

## 2.3 Route to v2 without enabling unrelated experiments

Modify:

```text id="yb9z7z"
apps/kimi-code/src/cli/experimental-v2.ts
apps/kimi-code/src/cli/run-prompt.ts
apps/kimi-code/src/cli/run-shell.ts
```

- [ ] Add `shouldUseKimiV2(opts, env)`.
- [ ] Return true when `opts.evolve` is true.
- [ ] Preserve the existing environment-controlled v2 path.
- [ ] Do not set `KIMI_CODE_EXPERIMENTAL_FLAG`.
- [ ] Do not enable unrelated experimental flags.
- [ ] Add tests proving `--evolve` routes print mode to `runV2Print`.
- [ ] Add tests proving `--evolve` routes shell mode through `createKimiHarnessV2`.
- [ ] Add tests proving ordinary invocations retain their existing engine selection.

## 2.4 CLI tests

Modify:

```text id="6tjzjd"
apps/kimi-code/test/cli/options.test.ts
```

- [ ] Test default `evolve === false`.
- [ ] Test `--evolve`.
- [ ] Test help output.
- [ ] Test every valid combination.
- [ ] Test every invalid combination.
- [ ] Test hidden aliases for yolo remain unchanged.
- [ ] Test `--evolve` does not mutate process environment.
- [ ] Test `--evolve` does not globally enable experimental flags.

**Done when:** CLI parsing, help, validation, print routing, shell routing, and regression tests all pass.

---

# 3. Carry adaptive activation through KC bootstrap

`IBootstrapService.args` is KC’s frozen process-level host invocation snapshot. It is the correct location for host activation rather than a new global singleton. fileciteturn165file0L1-L6

Modify:

```text id="e47enz"
packages/agent-core-v2/src/app/bootstrap/bootstrap.ts
apps/kimi-code/src/cli/v2/run-v2-print.ts
packages/node-sdk/src/types.ts
packages/node-sdk/src/sdk-rpc-client-v2.ts
packages/node-sdk/src/sdk-rpc-client.ts
packages/node-sdk/src/index.ts
```

## 3.1 Extend host arguments

- [ ] Add:

```ts id="1ah7wk"
export type AdaptiveHostMode = 'disabled' | 'enabled';

export interface HostArgs {
  readonly adaptiveMode: AdaptiveHostMode;
}
```

- [ ] Add `adaptiveMode?: AdaptiveHostMode` to `HostArgsInput`.
- [ ] Default it to `'disabled'`.
- [ ] Freeze it with the rest of the bootstrap snapshot.
- [ ] Add bootstrap resolution tests.
- [ ] Add a diagnostic inspection field showing the resolved mode.

## 3.2 Extend SDK options

- [ ] Add `adaptiveMode?: AdaptiveHostMode` to `KimiHarnessOptions`.
- [ ] Add it to `SDKRpcClientV2Options`.
- [ ] Pass it into `BootstrapInput.args`.
- [ ] Ensure `createKimiHarnessV2()` carries the property.
- [ ] Ensure v1 ignores or rejects it explicitly rather than accidentally enabling anything.
- [ ] Add SDK constructor tests.

## 3.3 Pass activation from both CLI paths

- [ ] In `run-v2-print.ts`, pass `'enabled'` when `opts.evolve`.
- [ ] In `run-shell.ts`, pass `'enabled'` into `createKimiHarnessV2`.
- [ ] Confirm the TUI’s single process-wide harness applies the mode consistently to all sessions created during that invocation.
- [ ] Ensure resumed sessions do not persist the invocation flag as permanently enabled.
- [ ] Ensure adaptive artifacts remain discoverable when the current host mode is disabled.

**Done when:** every v2 host can identify whether adaptive execution is enabled without consulting `process.env` or reparsing CLI state.

---

# 4. Create the new package and domain skeletons

The root workspace already includes `packages/*`, so the new package requires no workspace-glob edit. fileciteturn147file0L1-L6

## 4.1 Add `packages/program-evolution`

Create:

```text id="bswk9a"
packages/program-evolution/
├── package.json
├── tsconfig.json
├── src/
│   ├── candidate/
│   ├── generation/
│   ├── mutation/
│   ├── evaluation/
│   ├── archive/
│   ├── prompts/
│   ├── service/
│   └── index.ts
└── test/
```

- [ ] Name the package `@moonshot-ai/program-evolution`.
- [ ] Declare `@moonshot-ai/agent-core-v2` as a workspace dependency.
- [ ] Add build, typecheck, test, and clean scripts.
- [ ] Add package exports.
- [ ] Add import-boundary rules preventing core from importing the implementation package.
- [ ] Add a side-effect registration entrypoint.
- [ ] Add package-level README documenting trusted and mutable boundaries.
- [ ] Add a changeset.

## 4.2 Add core domains

Create every approved domain:

```text id="52vj8e"
agent/adaptiveRuntime
agent/adaptivePrompt
agent/adaptiveMemory
agent/evaluationEvidence
agent/causalRuleGraph
agent/worldModel
agent/testTimeSearch
session/evaluation
session/evaluationLedger
session/codeStructure
session/structuralSignals
session/candidateWorkspace
session/evaluationSandbox
session/searchCheckpoint
session/worldModelEvolution
```

- [ ] Add a public contract file to each domain.
- [ ] Add a production service implementation.
- [ ] Add a config section or typed config reader where required.
- [ ] Add domain-specific error codes.
- [ ] Add events where required.
- [ ] Add direct tests.
- [ ] Add exports and side-effect registration imports to `packages/agent-core-v2/src/index.ts`.

KC’s package index intentionally loads scoped-service registrations through imports, so all new production registrations must be represented there. fileciteturn164file0L1-L6 fileciteturn185file0L1-L2

**Done when:** every directory exists, every contract resolves, every service registers at the correct scope, and an import-boundary test proves dependency direction.

---

# 5. Add shared adaptive contracts and identifiers

Create:

```text id="7a74sw"
packages/agent-core-v2/src/agent/adaptiveRuntime/
├── adaptiveIdentifiers.ts
├── adaptiveProtocol.ts
├── adaptiveBudget.ts
├── adaptivePhase.ts
├── adaptiveDecision.ts
├── adaptiveArtifact.ts
└── adaptiveErrors.ts
```

- [ ] Define branded identifiers:
  - [ ] `AdaptiveRunId`;
  - [ ] `SearchEpisodeId`;
  - [ ] `SearchNodeId`;
  - [ ] `SearchDecisionId`;
  - [ ] `EvaluationId`;
  - [ ] `EvaluationReplicateId`;
  - [ ] `EvidenceId`;
  - [ ] `ArtifactId`;
  - [ ] `CandidateId`;
  - [ ] `WorldModelSetId`;
  - [ ] `CausalRuleId`;
  - [ ] `ConflictId`;
  - [ ] `WorkspaceSnapshotId`.
- [ ] Use opaque string types at compile time.
- [ ] Use UUIDv4 or content hashes according to identity semantics.
- [ ] Define canonical JSON serialization.
- [ ] Define all protocol-version constants.
- [ ] Define cross-domain timestamps and monotonic sequence numbers.
- [ ] Define `AdaptiveBudget`.
- [ ] Define `AdaptiveCost`.
- [ ] Define `AdaptivePhase`.
- [ ] Define terminal and nonterminal phase transitions.
- [ ] Define cancellation and infrastructure-failure payloads.
- [ ] Add Zod schemas for every persisted or RPC-visible contract.
- [ ] Add round-trip tests.
- [ ] Add canonicalization tests.
- [ ] Add invalid-data rejection tests.

**Done when:** no subsystem uses untyped arbitrary strings or duplicate local definitions for shared IDs, budgets, phases, or artifacts.

---

# 6. Add adaptive error domains

Modify:

```text id="h43622"
packages/agent-core-v2/src/errors.ts
```

Create domain error files for:

```text id="emgoqt"
adaptiveRuntime
evaluation
evaluationLedger
candidateWorkspace
evaluationSandbox
codeStructure
structuralSignals
causalRuleGraph
worldModel
testTimeSearch
worldModelEvolution
adaptivePrompt
adaptiveMemory
```

- [ ] Add stable codes for:
  - [ ] adaptive mode unavailable;
  - [ ] unsupported platform;
  - [ ] sandbox unavailable;
  - [ ] sandbox capability denied;
  - [ ] sandbox resource limit;
  - [ ] evidence corrupted;
  - [ ] evidence hash mismatch;
  - [ ] ledger append failure;
  - [ ] ledger recovery failure;
  - [ ] evaluation invalid;
  - [ ] evaluator unavailable;
  - [ ] evaluation timed out;
  - [ ] evaluation infrastructure failure;
  - [ ] baseline snapshot failure;
  - [ ] candidate workspace conflict;
  - [ ] live workspace changed;
  - [ ] candidate patch rejected;
  - [ ] world model compile failure;
  - [ ] world model resource limit;
  - [ ] no viable world model;
  - [ ] search checkpoint incompatible;
  - [ ] search budget exhausted;
  - [ ] commit rejected;
  - [ ] unsupported final claim;
  - [ ] signal queue overflow.
- [ ] Aggregate every new error contribution into `ErrorCodes`.
- [ ] Add serialization tests.
- [ ] Verify SDK and print surfaces preserve code and details.
- [ ] Verify infrastructure failures are not misclassified as candidate failures.

KC aggregates domain error contributions centrally, so missing imports would silently omit codes from the public facade. fileciteturn199file0L1-L6

**Done when:** every failure path yields a stable machine-readable code and no Evolve error is represented only by an arbitrary message.

---

# 7. Add complete adaptive configuration

Create one root adaptive schema with typed nested sections, while allowing each domain to own its subsection schema.

```toml id="3a7za8"
[adaptive]
enabled_by_default = false

[adaptive.models]
proposal = ""
repair = ""
evaluation_design = ""
action_proposal = ""
trajectory_compression = ""
policy_value = ""

[adaptive.budget]
...

[adaptive.evaluation]
...

[adaptive.world_model]
...

[adaptive.search]
...

[adaptive.evolution]
...

[adaptive.sandbox]
...

[adaptive.memory]
...

[adaptive.signals]
...
```

- [ ] Register the root schema through KC’s existing `registerConfigSection` contribution mechanism. Existing config domains self-register at import time. fileciteturn174file0L1-L6
- [ ] Keep `enabled_by_default` false for the approved CLI behavior.
- [ ] Make `--evolve` override the disabled default for the current invocation.
- [ ] Resolve all model-role aliases once per adaptive run.
- [ ] Default unspecified internal model roles to the bound primary model.
- [ ] Record resolved model IDs and thinking settings in the run manifest.
- [ ] Define token, request, tool, evaluation, wall-clock, CPU, memory, disk, and candidate-count budgets.
- [ ] Define evaluator-specific timeout overrides.
- [ ] Define search depth, node, branch, and transposition limits.
- [ ] Define entropy temperature limits.
- [ ] Define stochastic replicate limits.
- [ ] Define sandbox backend preferences.
- [ ] Define artifact-retention limits.
- [ ] Define status-rendering preferences.
- [ ] Validate all cross-field constraints.
- [ ] Reject invalid configuration before creating an adaptive run.
- [ ] Add generated config manifest entries.
- [ ] Add config mapping support to node SDK v2.
- [ ] Add config diagnostics.
- [ ] Add exhaustive config tests.

**Done when:** no required behavior depends on a hard-coded unexplained constant, and all defaults are visible, validated, recorded, and testable.

---

# 8. Define adaptive persistence layout

Use `ISessionContext.scope('adaptive/...')` for session-local state. The session context already supports arbitrary child persistence scopes. fileciteturn169file0L1-L6

Add a global adaptive scope for cross-task archives and learned policies:

- [ ] Extend `PersistenceScopeName` with `adaptive`.
- [ ] Use `bootstrap.scope('adaptive')` only for global promoted artifacts.
- [ ] Use `sessionContext.scope('adaptive')` for all task-time state.

Create the session layout:

```text id="hg4tou"
<session>/
└── adaptive/
    ├── manifest.json
    ├── ledger.jsonl
    ├── ledger-head.json
    ├── signals.jsonl
    ├── signal-reducer.json
    ├── evidence-index.json
    ├── conflicts.json
    ├── causal-rules.jsonl
    ├── world-models.jsonl
    ├── beliefs.jsonl
    ├── evaluations.jsonl
    ├── search-nodes.jsonl
    ├── search-edges.jsonl
    ├── checkpoint.json
    ├── candidate-lineage.jsonl
    ├── trajectory-summaries.jsonl
    ├── artifacts/
    └── workspaces/
```

Create the global layout:

```text id="fjtyjo"
<home>/adaptive/
├── program-archive/
├── promoted-prompts/
├── promoted-search-policy/
├── calibration/
└── benchmark-history/
```

- [ ] Use `IAppendLogStore` for ordered logs.
- [ ] Use `IBlobStore` for content-addressed artifacts.
- [ ] Use `IAtomicDocumentStore` for current heads and snapshots.
- [ ] Acquire and release store handles correctly.
- [ ] Flush stores on session close, export, cancellation, and normal completion.
- [ ] Enforce content-addressed write-once behavior above `IBlobStore`.
- [ ] Reject attempts to overwrite an existing artifact with different bytes.
- [ ] Define retention and garbage-collection rules.
- [ ] Never garbage-collect artifacts referenced by a ledger, checkpoint, promoted candidate, or export manifest.
- [ ] Add crash-recovery tests for every store combination.

The existing stores provide append-log, blob, and atomic-document access patterns, but the adaptive services must enforce their stronger immutability rules. fileciteturn166file0L1-L6 fileciteturn167file0L1-L6 fileciteturn168file0L1-L6

**Done when:** killing the process at any persistence boundary produces either the previous valid state or the new valid state, never a fabricated hybrid.

---

# 9. Implement the immutable evidence ledger

Create:

```text id="laasju"
session/evaluationLedger/
├── evaluationLedger.ts
├── evaluationLedgerService.ts
├── evaluationRecord.ts
├── evaluationRecordSchema.ts
├── ledgerHead.ts
├── ledgerIntegrity.ts
├── evidenceGraph.ts
├── evidenceClaim.ts
└── configSection.ts
```

## 9.1 Ledger records

- [ ] Define all record types:
  - [ ] adaptive run started;
  - [ ] adaptive phase changed;
  - [ ] baseline captured;
  - [ ] request recorded;
  - [ ] tool call recorded;
  - [ ] tool result recorded;
  - [ ] evaluation started;
  - [ ] replicate completed;
  - [ ] evaluation completed;
  - [ ] counterexample recorded;
  - [ ] structural signal recorded;
  - [ ] conflict opened;
  - [ ] conflict resolved;
  - [ ] causal rule proposed;
  - [ ] causal rule superseded;
  - [ ] world model proposed;
  - [ ] world model evaluated;
  - [ ] posterior updated;
  - [ ] search action proposed;
  - [ ] search action selected;
  - [ ] real action executed;
  - [ ] checkpoint committed;
  - [ ] commit selected;
  - [ ] final claim verified;
  - [ ] run completed;
  - [ ] run cancelled;
  - [ ] run failed.
- [ ] Include protocol version, sequence, previous hash, and current hash.
- [ ] Canonicalize payloads before hashing.
- [ ] Commit referenced artifacts before appending their record.
- [ ] Make append failure fatal to adaptive execution.
- [ ] Never use append-log `rewrite` through the ledger abstraction.
- [ ] Verify the complete chain at startup and resume.
- [ ] Stop immediately on corruption.
- [ ] Add a ledger inspection API.
- [ ] Add a deterministic export summary.
- [ ] Add corruption-injection tests at every line boundary.

## 9.2 Evidence graph

- [ ] Define evidence nodes.
- [ ] Define typed evidence links.
- [ ] Validate link endpoints.
- [ ] Prevent cycles in relations that must remain causal.
- [ ] Permit cycles only in explicitly noncausal cross-reference relations.
- [ ] Add transitive provenance queries.
- [ ] Add “evidence supporting claim” queries.
- [ ] Add “counterexamples contradicting rule” queries.
- [ ] Add “decision selected by evidence” queries.
- [ ] Add query performance tests on large synthetic ledgers.

## 9.3 Final claims

- [ ] Represent each final claim as a typed claim node.
- [ ] Require direct or transitive evidence references.
- [ ] Reject “tests passed” without a successful relevant evaluation result.
- [ ] Reject “fixed” without a verified task candidate.
- [ ] Reject “all tests” when only a subset ran.
- [ ] Preserve uncertainty qualifiers when evidence is incomplete.

**Done when:** every important adaptive conclusion can be reconstructed from immutable records without reading hidden model reasoning.

---

# 10. Add host-owned LLM request provenance

KC currently records durable `llm.request` Ops with model, provider, prompt hash, tool hash, projection, and request settings. fileciteturn198file0L1-L6

Modify:

```text id="cyvcwh"
kosong/contract/requestTrace.ts
agent/llmRequester/llmRequester.ts
agent/llmRequester/llmRequesterService.ts
agent/llmRequester/llmRequestOps.ts
```

## 10.1 Local request identity

- [ ] Add immutable `requestId` to `LLMRequestTrace`.
- [ ] Generate it before any asynchronous request work.
- [ ] Preserve provider `traceId` separately.
- [ ] Update loop state to track both IDs where necessary.
- [ ] Update telemetry to include both IDs.
- [ ] Update tool execution context to include both IDs.
- [ ] Add tests for provider requests with no trace ID.
- [ ] Add tests for trace IDs arriving late.
- [ ] Add tests for retries and projection rebuilds.

## 10.2 Exact request hashing

- [ ] Hash the final resolved system prompt.
- [ ] Hash final projected messages after tool selection.
- [ ] Hash final messages after media resolution.
- [ ] Hash the exact tool schema sent.
- [ ] Record projection kind.
- [ ] Record dropped-message count.
- [ ] Record adaptive prompt fragment IDs and hashes.
- [ ] Record selected evidence references.
- [ ] Record world-model set ID.
- [ ] Record search decision ID.
- [ ] Record evaluation context ID.
- [ ] Record internal request kind.
- [ ] Record request attempt number.
- [ ] Record resolved model role.
- [ ] Record completion budget and thinking setting.
- [ ] Record input token count when known.

KC’s requester performs tool-history shaping, projection, and media resolution before dispatch, so request hashing must occur at the final provider-facing boundary. fileciteturn197file0L1-L2

## 10.3 Internal operation requests

- [ ] Add request kinds:
  - [ ] `world-model.propose`;
  - [ ] `world-model.repair`;
  - [ ] `evaluation.design`;
  - [ ] `counterfactual.generate`;
  - [ ] `search.propose-actions`;
  - [ ] `search.policy-value`;
  - [ ] `adaptive-memory.compress`;
  - [ ] `final-response.plan`;
  - [ ] `final-response.verify`.
- [ ] Ensure operation requests never enter ordinary conversation history.
- [ ] Ensure operation requests never emit visible assistant deltas.
- [ ] Record their usage and provenance.
- [ ] Apply adaptive model-role routing.
- [ ] Apply cancellation and budget limits.
- [ ] Add structured-output validation.
- [ ] Retry invalid structured output only within explicit policy.
- [ ] Record all failed attempts.

**Done when:** the exact causal chain from search decision to provider request to tool action is reconstructable.

---

# 11. Capture raw tool evidence before truncation

The current executor obtains a raw tool result, finalizes it through hooks, truncates it for the model, then publishes and returns the finalized result. fileciteturn196file0L1-L6

Modify:

```text id="tdihex"
tool/toolContract.ts
agent/toolExecutor/toolExecutor.ts
agent/toolExecutor/toolExecutorService.ts
agent/toolExecutor/toolHooks.ts
```

## 11.1 Extend result contracts

- [ ] Add `ToolEvidenceEnvelope`.
- [ ] Add optional structured evidence to success and error results.
- [ ] Add artifact references.
- [ ] Add evidence schema version.
- [ ] Add evidence sensitivity classification.
- [ ] Add full-result byte size.
- [ ] Keep internal evidence fields out of model-facing persistence.
- [ ] Keep loop-control fields separate.

## 11.2 Capture path

- [ ] Inject `IAgentEvaluationEvidenceService` into `AgentToolExecutorService`.
- [ ] Capture raw result before `finalizeToolResult`.
- [ ] Commit explicit tool-provided evidence.
- [ ] Commit generic raw-output evidence when a tool provides none.
- [ ] Record tool name, tool source, args hash, duration, access declarations, and outcome.
- [ ] Link evidence to request ID, turn ID, step ID, and tool-call ID.
- [ ] Return evidence references in `ToolExecutionResult`.
- [ ] Preserve current model-facing truncation behavior.
- [ ] Preserve current hook behavior.
- [ ] Preserve current telemetry.
- [ ] Add tests proving evaluator evidence remains complete when model output is truncated.
- [ ] Add tests proving sensitive evidence is not injected into the model context automatically.

## 11.3 Tool updates

- [ ] Optionally retain structured progress events when an evaluator declares them relevant.
- [ ] Do not retain every transient progress event by default.
- [ ] Add deterministic coalescing.
- [ ] Record foreground-task transitions.
- [ ] Link background-task output artifacts.

**Done when:** an evaluator can reconstruct actual tool behavior without parsing the shortened model-facing response.

---

# 12. Add structured Bash and process evidence

Modify:

```text id="hlocwl"
agent/tools/os/bash/bashTool.ts
session/process/processRunner.ts
session/process/processRunnerService.ts
workspace/workspaceProcess/workspaceProcessRunnerService.ts
```

- [ ] Record command argv or exact shell source.
- [ ] Record working directory.
- [ ] Record sanitized environment manifest.
- [ ] Record process ID only as transient diagnostic metadata.
- [ ] Record start and end monotonic timestamps.
- [ ] Record exit code.
- [ ] Record termination signal.
- [ ] Record timeout status.
- [ ] Record foreground/background transition.
- [ ] Record stdout artifact.
- [ ] Record stderr artifact.
- [ ] Record full combined-output artifact where applicable.
- [ ] Record output byte counts.
- [ ] Record truncation applied to model output separately.
- [ ] Record task ID for background processes.
- [ ] Add evaluator-friendly JSON parsing where a command declares a machine-readable report.
- [ ] Add process resource metrics where the platform backend supports them.
- [ ] Add tests for:
  - [ ] successful process;
  - [ ] nonzero exit;
  - [ ] signal termination;
  - [ ] timeout;
  - [ ] cancellation;
  - [ ] huge stdout;
  - [ ] huge stderr;
  - [ ] binary output;
  - [ ] detached task;
  - [ ] output retrieval.

KC’s process abstraction already provides streams, exit state, waiting, killing, and disposal. fileciteturn141file0L1-L6

**Done when:** process-based evaluators consume structured process truth rather than human-readable Bash output.

---

# 13. Implement baseline snapshots and candidate workspaces

Create:

```text id="uqvdfq"
session/candidateWorkspace/
├── candidateWorkspace.ts
├── candidateWorkspaceService.ts
├── baselineSnapshot.ts
├── baselineSnapshotService.ts
├── workspaceMaterializer.ts
├── workspaceHasher.ts
├── workspaceDiff.ts
├── patchApplication.ts
├── patchRebase.ts
├── liveWorkspaceReconcile.ts
├── workspaceCleanup.ts
└── configSection.ts
```

## 13.1 Baseline capture

- [ ] Detect Git repository roots.
- [ ] Capture current commit.
- [ ] Capture staged changes.
- [ ] Capture unstaged tracked changes.
- [ ] Capture untracked nonignored files.
- [ ] Capture executable bits.
- [ ] Capture symlink targets.
- [ ] Capture relevant submodules.
- [ ] Capture additional workspace directories.
- [ ] Capture lockfiles and package manifests.
- [ ] Capture evaluator-declared ignored configuration.
- [ ] Exclude secrets and unsupported external directories.
- [ ] Produce a deterministic snapshot hash.
- [ ] Store a snapshot manifest.
- [ ] Store required file artifacts content-addressably.
- [ ] Verify snapshot reconstruction.
- [ ] Add dirty-worktree tests.
- [ ] Add Unicode and case-sensitivity tests.
- [ ] Add symlink safety tests.

## 13.2 Candidate materialization

- [ ] Use detached Git worktrees when available.
- [ ] Apply frozen staged and unstaged changes.
- [ ] Copy frozen untracked files.
- [ ] Apply candidate patches deterministically.
- [ ] Use reflink copy for non-Git workspaces when available.
- [ ] Fall back to complete copy when required.
- [ ] Verify resulting candidate hash.
- [ ] Prevent writes outside the candidate root.
- [ ] Assign one candidate workspace per candidate revision.
- [ ] Reuse read-only baseline assets safely.
- [ ] Clean candidate workspaces after retention expiry.
- [ ] Preserve workspaces required by active evaluations or debugging exports.

## 13.3 Patch formats

- [ ] Support validated unified diffs for task patches.
- [ ] Support structured file replacements.
- [ ] Support AST-based world-model mutations.
- [ ] Reject path traversal.
- [ ] Reject edits outside allowed workspace roots.
- [ ] Detect overlapping hunks.
- [ ] Detect stale-base application.
- [ ] Produce minimized patch artifacts.
- [ ] Calculate patch complexity.

## 13.4 Live reconciliation

- [ ] Rehash the live workspace before final apply.
- [ ] Rebase the selected patch when the user changed files.
- [ ] Preserve user edits.
- [ ] Recompute structural effects.
- [ ] Rerun affected hard gates.
- [ ] Reject unresolved merge conflicts.
- [ ] Never force-write over changed user files.
- [ ] Add concurrent-user-edit tests.

**Done when:** no candidate evaluation can alter the live workspace and final application cannot erase user changes.

---

# 14. Implement the secure evaluation sandbox

Create:

```text id="hc3miv"
session/evaluationSandbox/
├── evaluationSandbox.ts
├── evaluationSandboxService.ts
├── sandboxBackend.ts
├── sandboxBackendRegistry.ts
├── sandboxCapabilities.ts
├── sandboxEnvironment.ts
├── sandboxLimits.ts
├── sandboxResult.ts
├── linuxSandboxBackend.ts
├── windowsWslSandboxBackend.ts
├── macContainerSandboxBackend.ts
└── configSection.ts
```

## 14.1 Capability model

- [ ] Define explicit capabilities:
  - [ ] candidate workspace read;
  - [ ] candidate workspace write;
  - [ ] temporary-directory write;
  - [ ] package-cache read;
  - [ ] bounded process spawning;
  - [ ] network;
  - [ ] GPU;
  - [ ] additional mounted directory.
- [ ] Deny all capabilities not explicitly granted.
- [ ] Require evaluator registration to declare capabilities.
- [ ] Reject capability escalation at execution time.
- [ ] Record capabilities in evaluation evidence.

## 14.2 Environment sanitization

- [ ] Build an explicit environment allowlist.
- [ ] Use an isolated `HOME`.
- [ ] Use an isolated temporary directory.
- [ ] Remove credentials.
- [ ] Remove cloud environment variables.
- [ ] Remove SSH agent sockets.
- [ ] Block cloud metadata endpoints.
- [ ] Block user browser/session state.
- [ ] Block host process namespace access.
- [ ] Mount shared dependency caches read-only.
- [ ] Prevent writes to other candidate workspaces.

## 14.3 Resource limits

- [ ] CPU-time limit.
- [ ] Wall-clock limit.
- [ ] Memory limit.
- [ ] Process-count limit.
- [ ] File-size limit.
- [ ] Total written-byte limit.
- [ ] Output-byte limit.
- [ ] Open-file limit.
- [ ] Network-byte limit when network is explicitly enabled.
- [ ] Deterministic resource-limit error results.

## 14.4 Platform support

- [ ] Implement Linux backend.
- [ ] Implement Windows WSL2 backend.
- [ ] Implement macOS container backend.
- [ ] Add capability detection.
- [ ] Produce actionable startup diagnostics.
- [ ] Fail before the first adaptive run when no secure backend is available.
- [ ] Do not add an unrestricted child-process fallback.
- [ ] Add backend-specific security tests.
- [ ] Add escape-attempt adversarial tests.

**Done when:** evolved code and candidate evaluations cannot access live user data, credentials, hidden evaluators, or host authority beyond their declared capabilities.

---

# 15. Implement the evaluation registry

Create:

```text id="k00qso"
session/evaluation/
├── evaluation.ts
├── evaluationService.ts
├── evaluationRegistry.ts
├── evaluationContribution.ts
├── evaluationScheduler.ts
├── evaluationPlan.ts
├── evaluationSpec.ts
├── evaluationResult.ts
├── evaluationBudget.ts
├── evaluationCost.ts
├── evaluationCache.ts
├── environmentManifest.ts
├── outcomeProjection.ts
├── sequentialStopping.ts
├── multipleTesting.ts
├── counterexample.ts
├── counterexampleMinimizer.ts
├── evaluationEvents.ts
└── configSection.ts
```

## 15.1 Registry behavior

- [ ] Register evaluators by stable ID and version.
- [ ] Reject duplicate evaluator IDs.
- [ ] Validate input and result schemas.
- [ ] Declare deterministic versus stochastic mode.
- [ ] Declare sound versus empirical semantics.
- [ ] Declare scale and level.
- [ ] Declare outcome family.
- [ ] Declare required capabilities.
- [ ] Declare cache policy.
- [ ] Declare timeout policy.
- [ ] Declare counterexample minimizer.
- [ ] Declare outcome projection.
- [ ] Declare likelihood adapter.
- [ ] Expose evaluator metadata for search action generation.
- [ ] Keep protected evaluator implementation unavailable to candidate programs.

## 15.2 Scheduler

- [ ] Enforce global adaptive budget.
- [ ] Enforce per-evaluator budget.
- [ ] Enforce concurrency.
- [ ] Deduplicate exact deterministic evaluations.
- [ ] Deduplicate identical in-flight evaluations.
- [ ] Queue evaluations by frontier score and hard-gate priority.
- [ ] Support cancellation.
- [ ] Support sequential stochastic continuation.
- [ ] Commit replicate evidence before aggregation.
- [ ] Distinguish evaluator failure from candidate failure.
- [ ] Persist scheduler state for recovery.
- [ ] Apply backpressure.
- [ ] Record every scheduling decision.

## 15.3 Environment identity

Include:

- [ ] baseline snapshot hash;
- [ ] candidate patch hash;
- [ ] candidate workspace hash;
- [ ] operating system;
- [ ] architecture;
- [ ] sandbox backend and version;
- [ ] Node version;
- [ ] pnpm version;
- [ ] lockfile hash;
- [ ] dependency-state hash;
- [ ] evaluator version;
- [ ] configuration hash;
- [ ] permitted environment variables;
- [ ] seed;
- [ ] model role and model ID for agent evaluations.

## 15.4 Cache

- [ ] Cache deterministic evaluations only under exact environment identity.
- [ ] Treat stochastic cached outputs as individual replicates.
- [ ] Never reuse a replicate under a different seed.
- [ ] Record cache hit provenance.
- [ ] Invalidate on evaluator version change.
- [ ] Invalidate on relevant structural changes.
- [ ] Add stale-cache tests.

**Done when:** every evaluation is a typed, versioned, budgeted, isolated, recoverable operation.

---

# 16. Implement deterministic evaluators

Create adapters for every approved deterministic evaluator.

## 16.1 Syntax and static validity

- [ ] `typescript.parse`
- [ ] `typescript.typecheck`
- [ ] `typescript.lint`
- [ ] `repository.import-boundaries`
- [ ] `repository.generated-manifests`
- [ ] `repository.package-graph`
- [ ] `repository.build`

For each:

- [ ] use machine-readable outputs;
- [ ] preserve individual diagnostics;
- [ ] normalize paths;
- [ ] link diagnostics to structural nodes;
- [ ] minimize affected file sets;
- [ ] distinguish infrastructure errors;
- [ ] define hard-gate behavior.

## 16.2 Tests

- [ ] `vitest.test`
- [ ] focused test selection;
- [ ] changed-package tests;
- [ ] integration tests;
- [ ] full repository tests;
- [ ] exact test identity and duration;
- [ ] failed assertion extraction;
- [ ] snapshot-diff artifacts;
- [ ] test-to-structure mapping updates.

## 16.3 Persistence

- [ ] schema encode/decode;
- [ ] backward-compatible restore;
- [ ] session metadata replay;
- [ ] wire replay;
- [ ] export/import preservation;
- [ ] old-session compatibility;
- [ ] explicit migration checks.

## 16.4 Events

- [ ] publisher/subscriber payload compatibility;
- [ ] event type registration;
- [ ] event order invariants;
- [ ] event delivery count;
- [ ] SDK event mapping;
- [ ] print event mapping;
- [ ] kap-server broadcasting;
- [ ] subscriber disposal.

## 16.5 Causal validity

- [ ] complete-history replay;
- [ ] held-out transition replay;
- [ ] controlled intervention;
- [ ] counterfactual prediction;
- [ ] structural effect propagation;
- [ ] action-effect consistency;
- [ ] terminal prediction;
- [ ] reward/progress prediction.

## 16.6 Response validation

- [ ] required-content check;
- [ ] changed-file reporting check;
- [ ] verification-claim support check;
- [ ] unresolved-risk check;
- [ ] verbosity constraint;
- [ ] no hidden search narration;
- [ ] no unsupported test scope.

**Done when:** every hard-gate claim has a concrete evaluator and no evaluator relies on natural-language log parsing when structured data is available.

---

# 17. Implement stochastic evaluation

Create:

```text id="fzv28g"
session/evaluation/stochastic/
├── replicateRunner.ts
├── seedPolicy.ts
├── booleanEstimator.ts
├── categoricalEstimator.ts
├── scalarEstimator.ts
├── bootstrapEstimator.ts
├── tailRisk.ts
├── sequentialDecision.ts
└── calibration.ts
```

- [ ] Implement Beta-Bernoulli boolean estimation.
- [ ] Implement Wilson confidence intervals.
- [ ] Implement Dirichlet categorical estimation.
- [ ] Implement robust scalar location and dispersion.
- [ ] Implement deterministic bootstrap with recorded seed.
- [ ] Implement tail-failure estimation.
- [ ] Implement sequential stopping.
- [ ] Implement acceptance and rejection boundaries.
- [ ] Implement decision-change stopping.
- [ ] Implement maximum-replicate enforcement.
- [ ] Implement replicate parallelism.
- [ ] Prevent correlated replicate reuse.
- [ ] Record all seeds.
- [ ] Record scheduler conditions.
- [ ] Detect flakiness.
- [ ] Attribute likely noise source:
  - [ ] candidate;
  - [ ] repository;
  - [ ] evaluator;
  - [ ] scheduling;
  - [ ] provider;
  - [ ] infrastructure;
  - [ ] external service.
- [ ] Do not eliminate a candidate because of an infrastructure failure.
- [ ] Add tests for all estimator families.

Implement stochastic evaluators:

- [ ] randomized property tests;
- [ ] fuzzing;
- [ ] concurrency schedule stress;
- [ ] repeated benchmark runs;
- [ ] repeated agent rollouts;
- [ ] provider-variation rollouts;
- [ ] recovery reliability;
- [ ] environment perturbation;
- [ ] response reliability.

**Done when:** stochastic evidence produces calibrated distributions rather than an averaged scalar pretending to be deterministic truth.

---

# 18. Implement multiple-testing protection

- [ ] Define adaptation, confirmation, and promotion splits.
- [ ] Keep promotion inputs inaccessible to task-time generation.
- [ ] Record number of candidate attempts.
- [ ] Implement sequential alpha spending.
- [ ] Implement confirmation-reserve accounting.
- [ ] Require replicate confirmation for stochastic success.
- [ ] Prevent repeated score probing of hidden promotion cases.
- [ ] Detect evaluator overfitting.
- [ ] Track family-wise error metadata.
- [ ] Reject promotion based on one lucky candidate.
- [ ] Add synthetic p-hacking tests.
- [ ] Add hidden-split leakage tests.
- [ ] Add prompt-injection tests attempting to reveal hidden evaluations.

**Done when:** aggressive evaluation and candidate generation cannot manufacture apparent success through repeated selection.

---

# 19. Implement counterexample minimization

Create minimizers for:

- [ ] input values;
- [ ] property-test cases;
- [ ] file sets;
- [ ] patch hunks;
- [ ] event traces;
- [ ] environment variables;
- [ ] dependency changes;
- [ ] concurrency schedules;
- [ ] prompt context;
- [ ] world-model state;
- [ ] action sequences.

For every minimizer:

- [ ] preserve the failure;
- [ ] preserve environment identity;
- [ ] record minimization steps;
- [ ] enforce a budget;
- [ ] return the smallest found counterexample when budget expires;
- [ ] link the minimized result to the original evidence;
- [ ] test determinism under fixed seed.

**Done when:** program repair receives concise causal counterexamples rather than entire undifferentiated logs.

---

# 20. Build the deterministic code-structure graph

Create:

```text id="2v90zl"
session/codeStructure/
├── codeStructure.ts
├── codeStructureService.ts
├── codeStructureIndex.ts
├── codeStructureParser.ts
├── symbolIndex.ts
├── importGraph.ts
├── callGraph.ts
├── packageGraph.ts
├── persistenceGraph.ts
├── eventContractGraph.ts
├── generatedArtifactGraph.ts
├── testCoverageMap.ts
├── structureDiff.ts
├── structureQuery.ts
├── kcRecognizers.ts
└── codeStructureEvents.ts
```

## 20.1 Runtime dependencies

- [ ] Add the TypeScript compiler API as a declared runtime dependency.
- [ ] Pin its version consistently with the repository.
- [ ] Avoid relying on undeclared root-hoisted dependencies.

## 20.2 Structure nodes

Index:

- [ ] workspaces;
- [ ] packages;
- [ ] modules;
- [ ] files;
- [ ] symbols;
- [ ] functions;
- [ ] classes;
- [ ] interfaces;
- [ ] types;
- [ ] tests;
- [ ] configuration sections;
- [ ] wire models;
- [ ] wire Ops;
- [ ] event types;
- [ ] event publishers;
- [ ] event subscribers;
- [ ] scoped-service registrations;
- [ ] tool registrations;
- [ ] generated artifacts;
- [ ] persistence schemas.

## 20.3 Edges

Index:

- [ ] containment;
- [ ] imports;
- [ ] exports;
- [ ] calls;
- [ ] implements;
- [ ] extends;
- [ ] constructs;
- [ ] reads;
- [ ] writes;
- [ ] serializes;
- [ ] restores;
- [ ] publishes;
- [ ] subscribes;
- [ ] registers;
- [ ] generates;
- [ ] tests;
- [ ] depends on;
- [ ] invalidates.

## 20.4 KC recognizers

Recognize:

- [ ] `registerScopedService`;
- [ ] `registerConfigSection`;
- [ ] `defineModel`;
- [ ] `defineOp`;
- [ ] `declare module '#/app/event/eventBus'`;
- [ ] `registerAgentToolService`;
- [ ] `createDecorator`;
- [ ] side-effect imports;
- [ ] package barrels;
- [ ] config-manifest generators;
- [ ] wire-manifest generators;
- [ ] state-manifest generators;
- [ ] SDK event mappers;
- [ ] session export manifest types;
- [ ] persistence codecs.

## 20.5 Incremental indexing

- [ ] Parse only changed files when possible.
- [ ] Recompute invalidated edges.
- [ ] Handle deleted and renamed files.
- [ ] Handle path aliases.
- [ ] Handle project references.
- [ ] Handle generated files.
- [ ] Handle parse failures without destroying the prior valid index.
- [ ] Persist index checkpoints.
- [ ] Validate index hash.
- [ ] Add large-repository performance tests.

**Done when:** after any patch, the harness can enumerate affected definitions, callers, tests, persistence boundaries, events, manifests, and package consumers without asking the model to rediscover them.

---

# 21. Implement runtime event graphs and background listeners

Create:

```text id="gajtxy"
session/structuralSignals/
├── structuralSignal.ts
├── structuralSignalQueue.ts
├── structuralSignalService.ts
├── structuralSignalListeners.ts
├── structuralSignalReducer.ts
├── structuralConflict.ts
├── conflictIndex.ts
├── staleEvidenceDetector.ts
├── manifestDriftDetector.ts
├── eventOrderDetector.ts
├── candidateConflictDetector.ts
└── configSection.ts
```

KC already exposes each agent’s event bus and agent lifecycle creation/disposal events, so the Session-scoped listener can attach to every current and future agent. fileciteturn182file0L1-L6

## 21.1 Listener attachment

- [ ] Attach to all existing agents.
- [ ] Attach to future agents.
- [ ] Dispose subscriptions when agents are disposed.
- [ ] Attach workspace file watchers.
- [ ] Attach evaluation completion events.
- [ ] Attach world-model prediction events.
- [ ] Attach candidate lifecycle events.
- [ ] Attach search decision events.

## 21.2 Listener restrictions

- [ ] Listeners only normalize and enqueue facts.
- [ ] Listeners never call a model.
- [ ] Listeners never schedule an evaluation directly.
- [ ] Listeners never update beliefs.
- [ ] Listeners never accept or reject candidates.
- [ ] Listeners never commit a patch.

## 21.3 Signal queue

- [ ] Allocate monotonic session sequence numbers.
- [ ] Preserve per-agent event order.
- [ ] Define cross-agent arrival ordering.
- [ ] Debounce file changes.
- [ ] Sort path batches deterministically.
- [ ] Deduplicate identical signals.
- [ ] Coalesce repeated signals.
- [ ] Implement queue capacity.
- [ ] Implement backpressure.
- [ ] Open a commit-blocking overflow conflict when lossless processing is impossible.
- [ ] Persist the append log.
- [ ] Persist reducer position.
- [ ] Replay after crash.

## 21.4 Conflict classes

Detect:

- [ ] prediction conflict;
- [ ] scope conflict;
- [ ] evidence conflict;
- [ ] candidate conflict;
- [ ] event-order conflict;
- [ ] persistence conflict;
- [ ] manifest conflict;
- [ ] public-contract conflict;
- [ ] test-coverage conflict;
- [ ] stale-evidence conflict;
- [ ] signal overflow.

## 21.5 Conflict lifecycle

- [ ] Open.
- [ ] Schedule.
- [ ] Resolve.
- [ ] Supersede.
- [ ] Mark stale.
- [ ] Link evidence.
- [ ] Link structural nodes.
- [ ] Link causal rules.
- [ ] Suggest evaluator IDs.
- [ ] Block commit where severity requires it.
- [ ] Add idempotence tests.

**Done when:** cross-file and runtime contradictions are detected autonomously in the background without hidden nondeterministic decision-making.

---

# 22. Implement the causal-rule DAG

Create:

```text id="8ixre4"
agent/causalRuleGraph/
├── causalRule.ts
├── causalRuleSchema.ts
├── causalRuleGraph.ts
├── causalRuleGraphService.ts
├── causalRuleIndex.ts
├── causalRuleCanonicalization.ts
├── causalRuleEquivalence.ts
├── causalRuleLineage.ts
├── causalRuleConflict.ts
├── causalRuleComposition.ts
├── causalRuleGeneralization.ts
├── causalRulePosterior.ts
├── causalRuleOps.ts
└── causalRuleEvents.ts
```

## 22.1 Rule identity

- [ ] Stable rule ID.
- [ ] Semantic hash.
- [ ] Version.
- [ ] Parent rules.
- [ ] Child rules.
- [ ] Superseded rules.
- [ ] Structural scope.
- [ ] Subject references.
- [ ] Conditions.
- [ ] interventions;
- [ ] predicted effects;
- [ ] supporting evidence;
- [ ] contradicting evidence;
- [ ] posterior support;
- [ ] complexity;
- [ ] generalization score;
- [ ] status.

## 22.2 Canonicalization and equivalence

- [ ] Normalize variable names.
- [ ] Normalize commutative expressions.
- [ ] Normalize structural references.
- [ ] Deduplicate semantic equivalents.
- [ ] Distinguish specialization from contradiction.
- [ ] Detect incompatible overlapping effects.
- [ ] Preserve provenance when merging equivalent rules.
- [ ] Add equivalence property tests.

## 22.3 Graph operations

- [ ] Propose.
- [ ] Specialize.
- [ ] Generalize.
- [ ] Split.
- [ ] Merge.
- [ ] Compose.
- [ ] Supersede.
- [ ] Reject.
- [ ] Find counterexample.
- [ ] Test intervention.
- [ ] Propagate effects.

## 22.4 Generalization promotion

Enforce withheld prediction requirements for:

- [ ] symbol scope;
- [ ] file scope;
- [ ] module scope;
- [ ] package scope;
- [ ] repository scope;
- [ ] runtime scope;
- [ ] trajectory scope.

- [ ] Do not promote based only on mention count.
- [ ] Record exact held-out evidence.
- [ ] Revoke active promotion when later evidence contradicts it.
- [ ] Preserve historical promotion records.

## 22.5 Wire state

- [ ] Add a small replayable adaptive wire model.
- [ ] Persist only active IDs, hashes, heads, phase, and current summary.
- [ ] Keep large graphs in adaptive stores.
- [ ] Add Ops for:
  - [ ] run begin;
  - [ ] phase update;
  - [ ] evidence-head update;
  - [ ] rule-graph-head update;
  - [ ] world-model-set update;
  - [ ] search-checkpoint update;
  - [ ] commit selection;
  - [ ] run end.
- [ ] Add schemas.
- [ ] Add wire types contribution.
- [ ] Regenerate wire manifest.
- [ ] Add restore tests.

**Done when:** local, cross-file, package, repository, runtime, and trajectory rules form one queryable causal DAG with immutable lineage.

---

# 23. Implement executable world models

Create:

```text id="fq5qj1"
agent/worldModel/
├── worldModel.ts
├── worldModelService.ts
├── worldModelCandidate.ts
├── worldModelManifest.ts
├── worldModelCanonicalModel.ts
├── worldModelCompiler.ts
├── worldModelRuntime.ts
├── worldModelModuleProtocol.ts
├── worldModelBeliefs.ts
├── worldModelLikelihood.ts
├── worldModelReplay.ts
├── worldModelSimulation.ts
├── worldModelDisagreement.ts
├── worldModelCalibration.ts
├── worldModelOps.ts
├── worldModelEvents.ts
└── configSection.ts
```

## 23.1 Dual representation

- [ ] Implement canonical causal representation.
- [ ] Implement sandboxed executable module representation.
- [ ] Require each executable module to reference a canonical rule graph.
- [ ] Verify source hash, compiled hash, rule graph hash, and schemas.
- [ ] Reject modules whose behavior cannot be linked to declared rule IDs.
- [ ] Record compilation artifacts.

## 23.2 World-model module API

Implement:

- [ ] `encodeObservation`;
- [ ] `enumerateActions`;
- [ ] `predictTransition`;
- [ ] `predictObservation`;
- [ ] `predictReward`;
- [ ] `predictTerminal`;
- [ ] `projectOutcome`;
- [ ] `explainPrediction`.

## 23.3 Execution restrictions

- [ ] Run modules only inside the sandbox.
- [ ] Pass immutable serialized input.
- [ ] Pass selected structure slices.
- [ ] Pass selected evidence references.
- [ ] Pass explicit random seeds.
- [ ] Deny filesystem.
- [ ] Deny network.
- [ ] Deny process spawning.
- [ ] Deny environment access.
- [ ] Deny evidence writes.
- [ ] Deny hidden evaluator access.
- [ ] Enforce memory, CPU, wall, depth, and output limits.

## 23.4 Candidate gates

- [ ] Manifest validation.
- [ ] Parse.
- [ ] Compile.
- [ ] Sandbox validation.
- [ ] Complete-history replay.
- [ ] Held-out transition replay.
- [ ] Intervention consistency.
- [ ] Structural conflict consistency.
- [ ] Planning simulation.
- [ ] Calibration.
- [ ] Confirmation eligibility.

## 23.5 Population behavior

- [ ] Maintain at least three viable candidates before enabling epistemic discovery.
- [ ] Maintain candidate lineage.
- [ ] Mark hard-gate failures ineligible.
- [ ] Keep rejected candidates in the archive.
- [ ] Support population expansion.
- [ ] Support model replacement.
- [ ] Support ensemble prediction.
- [ ] Add adversarial model-exploitation tests.

**Done when:** the harness can execute, compare, reject, repair, and plan inside multiple causal models of a novel repository task.

---

# 24. Implement Bayesian beliefs and likelihoods

- [ ] Maintain log weights.
- [ ] Normalize safely with log-sum-exp.
- [ ] Represent zero likelihood as negative infinity.
- [ ] Separate hard-gate eligibility from soft posterior weight.
- [ ] Update from deterministic sound evidence.
- [ ] Update from empirical boolean evidence.
- [ ] Update from categorical evidence.
- [ ] Update from scalar evidence.
- [ ] Update from structured projected outcomes.
- [ ] Add probability floors only to empirical predictions.
- [ ] Never soften a sound deterministic contradiction.
- [ ] Compute effective sample size.
- [ ] Compute marginal rule support.
- [ ] Compute candidate disagreement.
- [ ] Persist every posterior update.
- [ ] Record input evidence IDs.
- [ ] Add normalization, underflow, and elimination tests.
- [ ] Add adversarial overconfident-model tests.

**Done when:** model belief changes are deterministic consequences of recorded evidence and declared likelihood semantics.

---

# 25. Implement entropy and epistemic discovery

Create:

```text id="99zlbe"
agent/testTimeSearch/
├── posteriorEntropy.ts
├── predictiveDistribution.ts
├── predictiveEntropy.ts
├── conditionalEntropy.ts
├── informationGain.ts
├── decisionSensitivity.ts
├── beliefTempering.ts
├── generalizationLeverage.ts
├── redundancyPenalty.ts
└── epistemicFrontier.ts
```

## 25.1 Entropy functions

- [ ] `posteriorEntropy`.
- [ ] `normalizedPosteriorEntropy`.
- [ ] `predictiveOutcomeEntropy`.
- [ ] `expectedConditionalOutcomeEntropy`.
- [ ] `epistemicInformationGain`.
- [ ] `expectedPosteriorEntropy`.
- [ ] `decisionWeightedInformationGain`.
- [ ] `ruleSupportEntropy`.
- [ ] `conflictEntropy`.

## 25.2 Outcome projection

- [ ] Boolean outcomes.
- [ ] Categorical outcomes.
- [ ] Binned scalar outcomes.
- [ ] Structured canonical outcomes.
- [ ] Remove process IDs, timestamps, temporary paths, and ordering noise.
- [ ] Preserve decision-relevant distinctions.
- [ ] Version every projection.

## 25.3 Decision sensitivity

Count changes to:

- [ ] preferred patch;
- [ ] preferred real action;
- [ ] commit eligibility;
- [ ] hard-gate result;
- [ ] required further evaluation;
- [ ] verified task-value ranking.

Do not count:

- [ ] cosmetic internal ranking;
- [ ] wording differences;
- [ ] irrelevant model disagreements.

## 25.4 Belief tempering

- [ ] Maintain true posterior separately.
- [ ] Derive a discovery-only tempered distribution.
- [ ] Default temperature to `0.75`.
- [ ] Lower toward `0.50` under verified stagnation and decision-relevant disagreement.
- [ ] Raise toward `1.00` under convergence or low budget.
- [ ] Never revive eliminated candidates.
- [ ] Never use tempered weights for final commit confidence.
- [ ] Record temperature changes and reasons.

## 25.5 Frontier score

Implement:

- [ ] expected task progress;
- [ ] decision-weighted information gain;
- [ ] generalization leverage;
- [ ] execution cost;
- [ ] execution risk;
- [ ] redundancy penalty;
- [ ] calibration penalty;
- [ ] budget pressure.

- [ ] Cap discovery bonus relative to exploitation value.
- [ ] Prevent novelty-only exploration.
- [ ] Prevent repeated equivalent evaluations.
- [ ] Add exact numerical tests.
- [ ] Add aleatoric-versus-epistemic tests.
- [ ] Add premature-collapse tests.

**Done when:** the search selects evaluations because they can alter the verified solution, not because outputs are merely diverse or noisy.

---

# 26. Implement calibration

- [ ] Track Brier score.
- [ ] Track log loss.
- [ ] Track confidence-interval coverage.
- [ ] Track reliability bins.
- [ ] Track calibration per evaluator family.
- [ ] Track calibration per world-model lineage.
- [ ] Mark miscalibrated evaluators and models.
- [ ] Penalize information-gain contribution when miscalibrated.
- [ ] Recalibrate from held-out evidence.
- [ ] Persist calibration artifacts globally.
- [ ] Version calibration data.
- [ ] Add synthetic calibration tests.
- [ ] Add regime-shift tests.
- [ ] Prevent promotion with severe miscalibration.

**Done when:** an overconfident but inaccurate world model cannot dominate frontier search merely by reporting narrow distributions.

---

# 27. Implement program evolution

Create the complete `packages/program-evolution` implementation.

## 27.1 Candidate representation

- [ ] Candidate bundle.
- [ ] source files;
- [ ] compiled artifacts;
- [ ] manifest;
- [ ] parent IDs;
- [ ] inspiration IDs;
- [ ] rule graph;
- [ ] state schema;
- [ ] observation schema;
- [ ] action schema;
- [ ] evidence head;
- [ ] evaluation summary;
- [ ] lineage;
- [ ] status.

## 27.2 Proposal generators

- [ ] new state abstraction;
- [ ] new causal decomposition;
- [ ] local rule repair;
- [ ] observation encoder repair;
- [ ] transition repair;
- [ ] uncertainty repair;
- [ ] likelihood repair;
- [ ] counterfactual repair;
- [ ] adversarial alternative;
- [ ] simplification;
- [ ] composition;
- [ ] recombination.

## 27.3 Structured generation

- [ ] Use internal operation requests.
- [ ] Validate structured output.
- [ ] Reject undeclared files.
- [ ] Reject evaluator or permission edits.
- [ ] Parse candidate bundles.
- [ ] Normalize source.
- [ ] Calculate hashes.
- [ ] Record failed generation attempts.
- [ ] Limit retry count.
- [ ] Preserve prompt versions.

## 27.4 Mutation operators

- [ ] rule mutation;
- [ ] schema mutation;
- [ ] transition mutation;
- [ ] observation mutation;
- [ ] likelihood mutation;
- [ ] uncertainty mutation;
- [ ] action-space mutation;
- [ ] simplification mutation;
- [ ] rule splitting;
- [ ] rule merging;
- [ ] state-factorization mutation.

## 27.5 Archive

- [ ] Content-addressed candidate store.
- [ ] Candidate lineage.
- [ ] Behavioral descriptors.
- [ ] Archive cells.
- [ ] Multiple islands.
- [ ] Parent selection.
- [ ] Inspiration selection.
- [ ] Novelty calculation.
- [ ] Quality calculation.
- [ ] Migration between islands.
- [ ] Age management.
- [ ] Archive pruning.
- [ ] Protection of promoted candidates.
- [ ] Crash recovery.
- [ ] Deterministic selection under fixed seed.

## 27.6 Candidate states

Implement every lifecycle state:

- [ ] proposed;
- [ ] parsed;
- [ ] compiled;
- [ ] sandbox-valid;
- [ ] history-consistent;
- [ ] held-out-consistent;
- [ ] intervention-consistent;
- [ ] planning-eligible;
- [ ] active;
- [ ] promoted;
- [ ] quarantined;
- [ ] rejected;
- [ ] archived.

## 27.7 Core contribution

- [ ] Implement `ISessionWorldModelEvolutionService`.
- [ ] Register it before v2 bootstrap.
- [ ] Provide a fail-loud unavailable implementation when the package is absent.
- [ ] Do not make core import `program-evolution`.
- [ ] Add integration tests for registration order.

**Done when:** current counterexamples can cause automatic model repair, state-abstraction expansion, recombination, archive insertion, and reevaluation without modifying trusted runtime code.

---

# 28. Implement belief-state tree search

Create:

```text id="efvszi"
agent/testTimeSearch/
├── testTimeSearch.ts
├── testTimeSearchService.ts
├── searchEpisode.ts
├── searchState.ts
├── searchAction.ts
├── searchNode.ts
├── searchEdge.ts
├── chanceNode.ts
├── terminalNode.ts
├── transpositionTable.ts
├── actionGenerator.ts
├── actionNormalizer.ts
├── actionPrior.ts
├── policyValue.ts
├── puct.ts
├── progressiveWidening.ts
├── beliefTransition.ts
├── valueVector.ts
├── valueBackup.ts
├── stoppingPolicy.ts
├── commitPolicy.ts
├── searchEvents.ts
└── configSection.ts
```

## 28.1 Search state

Include:

- [ ] baseline snapshot hash;
- [ ] active candidate workspace hash;
- [ ] belief-state hash;
- [ ] causal-rule graph hash;
- [ ] structure-index hash;
- [ ] unresolved-conflict hash;
- [ ] trajectory-summary hash;
- [ ] verified candidate IDs;
- [ ] remaining budget;
- [ ] current permission state;
- [ ] current user goal version.

## 28.2 Actions

Implement:

- [ ] inspect structure;
- [ ] run deterministic evaluation;
- [ ] run stochastic replicate;
- [ ] construct intervention;
- [ ] propose task patch;
- [ ] evaluate task patch;
- [ ] revise world model;
- [ ] expand world-model population;
- [ ] simulate task action;
- [ ] execute real task action;
- [ ] commit solution.

## 28.3 Action generators

Generate from:

- [ ] structural graph;
- [ ] open conflicts;
- [ ] evaluator templates;
- [ ] causal-rule DAG;
- [ ] world-model disagreement;
- [ ] LLM operation requests;
- [ ] prior successful trajectories;
- [ ] program archive;
- [ ] user steering.

## 28.4 PUCT

- [ ] Implement visit counts.
- [ ] Implement priors.
- [ ] Implement value estimates.
- [ ] Implement discovery-frontier bonus.
- [ ] Implement cost and risk penalties.
- [ ] Implement deterministic tie breaking.
- [ ] Add exact formula tests.

## 28.5 Progressive widening

- [ ] Enforce total branch limit.
- [ ] Enforce per-category quota.
- [ ] Keep a commit action available.
- [ ] Keep direct progress available.
- [ ] Keep uncertainty reduction available while relevant.
- [ ] Expand according to visits.
- [ ] Record why actions entered the tree.

## 28.6 Chance nodes

- [ ] Build posterior-weighted outcome probabilities.
- [ ] Support up to configured explicit outcomes.
- [ ] Group low-probability outcomes.
- [ ] Preserve outcome projection version.
- [ ] Update beliefs hypothetically.
- [ ] Back up expected value.
- [ ] Add stochastic chance-node tests.

## 28.7 Transpositions

- [ ] Define canonical decision-node key.
- [ ] Include budget bucket.
- [ ] Include goal version.
- [ ] Merge genuinely equivalent states.
- [ ] Reject false equivalence.
- [ ] Add collision tests.
- [ ] Add memory limits and eviction.

## 28.8 Receding-horizon reality execution

- [ ] Execute at most one irreversible external action before replanning.
- [ ] Observe actual results.
- [ ] Commit evidence.
- [ ] Rebuild the root state.
- [ ] Penalize reality gaps.
- [ ] Detect world-model exploitation.
- [ ] Quarantine models repeatedly exploited by planning.

## 28.9 Stopping and commit

- [ ] Require hard gates.
- [ ] Require no commit-blocking conflicts.
- [ ] Require action stability across viable models.
- [ ] Require low marginal value of information.
- [ ] Require live-workspace reconciliation.
- [ ] Require final claim support.
- [ ] Handle budget exhaustion.
- [ ] Handle no viable candidate.
- [ ] Add exhaustive commit-policy tests.

**Done when:** the harness can choose between testing, modeling, patching, acting, and stopping under one explicit value and budget system.

---

# 29. Implement policy and value guidance

To avoid leaving AlphaZero-style guidance as an unimplemented aspiration:

## 29.1 Runtime interface

Create:

```text id="168w4d"
agent/testTimeSearch/searchPolicyValue.ts
agent/testTimeSearch/searchPolicyValueService.ts
```

- [ ] Define policy-prior inference.
- [ ] Define state-value inference.
- [ ] Define uncertainty on prior/value estimates.
- [ ] Define model-role routing.
- [ ] Record every inference request.

## 29.2 Cold-start implementation

- [ ] Combine deterministic action priors.
- [ ] Combine structure/conflict urgency.
- [ ] Use a structured Kimi operation request to rank novel actions.
- [ ] Use evaluator-derived value estimates.
- [ ] Calibrate operation-request outputs.
- [ ] Ensure search still functions when policy inference fails by using recorded deterministic priors, not a silent no-op.

## 29.3 Search experience dataset

Persist:

- [ ] state features;
- [ ] legal actions;
- [ ] visit distribution;
- [ ] selected action;
- [ ] resulting evidence;
- [ ] verified return;
- [ ] cost;
- [ ] terminal outcome;
- [ ] task family;
- [ ] repository split.

## 29.4 Learned policy/value backend

Create a separate optional package or tooling directory:

```text id="wqsmy5"
packages/adaptive-policy/
or
tools/adaptive-policy/
```

- [ ] Dataset validator.
- [ ] Train/validation split.
- [ ] Feature encoder.
- [ ] Policy head.
- [ ] Value head.
- [ ] Cost/risk auxiliary heads.
- [ ] Training script.
- [ ] Checkpoint format.
- [ ] Export format.
- [ ] Runtime inference adapter.
- [ ] Calibration.
- [ ] Held-out benchmark.
- [ ] Rollback to incumbent promoted policy.
- [ ] Promotion gate.
- [ ] Model card.
- [ ] Reproducible training manifest.

The full runtime must work with the cold-start backend. The learned backend becomes active only after passing promotion.

**Done when:** search guidance is a concrete implemented service with collected training targets and a complete promotion path, not an undefined future network.

---

# 30. Implement the narrow adaptive prompt library

KC already has `IAgentContextInjectorService`, which registers named providers and injects system reminders at the beginning of steps. This is the appropriate existing seam for short phase-specific directives. fileciteturn186file0L1-L6 fileciteturn187file0L1-L6 fileciteturn189file0L1-L6

Create:

```text id="vux4ro"
agent/adaptivePrompt/
├── adaptivePrompt.ts
├── adaptivePromptLibrary.ts
├── adaptivePromptRouter.ts
├── adaptivePromptContext.ts
├── adaptivePromptTrace.ts
├── adaptivePromptService.ts
├── fragments/
└── configSection.ts
```

## 30.1 Add approved fragments verbatim

- [ ] `form-causal-hypotheses@1`
- [ ] `choose-discriminating-evaluation@1`
- [ ] `trace-structural-effects@1`
- [ ] `repair-from-counterexample@1`
- [ ] `verify-across-scales@1`
- [ ] `commit-concise-result@1`

## 30.2 Router behavior

- [ ] Select one primary fragment.
- [ ] Select at most one constraint fragment.
- [ ] Enforce token limits.
- [ ] Select deterministically from phase and flags.
- [ ] Do not explain Evolve architecture to the main solver.
- [ ] Do not include research names.
- [ ] Do not expose posterior calculations.
- [ ] Do not expose hidden evaluator details.
- [ ] Do not accumulate obsolete reminders.
- [ ] Replace or supersede prior phase reminders.
- [ ] Reinstate reminders after context compaction.
- [ ] Record fragment ID, version, and hash in request provenance.
- [ ] Prevent workspace instructions from overriding host-owned fragments.
- [ ] Add prompt-injection adversarial tests.
- [ ] Add snapshot tests for exact wording.

## 30.3 Internal prompt library

Add approved verbatim templates for:

- [ ] world-model proposal;
- [ ] world-model repair;
- [ ] evaluation design;
- [ ] counterfactual generation;
- [ ] search-action proposal;
- [ ] trajectory compression;
- [ ] final response planning;
- [ ] final claim verification.

- [ ] Version each prompt.
- [ ] Hash each prompt.
- [ ] Validate structured output.
- [ ] Make task-time prompt mutation impossible.
- [ ] Implement cross-task prompt promotion separately.
- [ ] Preserve safety, permissions, evidence integrity, and concise commit as immutable.

**Done when:** the agent reliably performs Evolve behaviors without receiving a large architectural lecture or accumulating repetitive global instructions.

---

# 31. Implement adaptive memory and evidence selection

Create:

```text id="xk0f86"
agent/adaptiveMemory/
├── adaptiveMemory.ts
├── adaptiveMemoryService.ts
├── trajectorySummary.ts
├── hypothesisSummary.ts
├── failureSummary.ts
├── evidenceSelection.ts
├── contextBudget.ts
├── summaryValidation.ts
└── configSection.ts
```

- [ ] Preserve full immutable evidence externally.
- [ ] Build compact trajectory summaries.
- [ ] Build hypothesis summaries.
- [ ] Build failure summaries.
- [ ] Build open-conflict summaries.
- [ ] Build verified-progress summaries.
- [ ] Validate summaries against evidence.
- [ ] Reject summaries containing unsupported claims.
- [ ] Score evidence by structural relevance.
- [ ] Score evidence by causal relevance.
- [ ] Score evidence by decision relevance.
- [ ] Penalize redundancy.
- [ ] Enforce active-context budgets.
- [ ] Preserve decisive counterexamples.
- [ ] Preserve relevant exact diagnostics.
- [ ] Drop repeated logs.
- [ ] Drop abandoned speculative wording.
- [ ] Rehydrate summaries on resume.
- [ ] Invalidate summaries after goal steering or structural change.
- [ ] Add long-trajectory tests.

**Done when:** Evolve can run long investigations without losing evidence or flooding the active model context.

---

# 32. Integrate Evolve into the authoritative KC loop

`AgentLoopService` currently materializes a step, runs `onWillBeginStep`, starts one LLM request, executes tools, records `step.end`, then runs the advisory `onDidFinishStep` hook. Nonabort failures from the final hook are swallowed. fileciteturn190file0L1-L6 fileciteturn193file0L1-L6 fileciteturn192file0L1-L6

Modify:

```text id="l6g1g2"
agent/loop/loopService.ts
agent/loop/loop.ts
agent/loop/stepRequest.ts
agent/loop/stepRequestQueue.ts
```

## 32.1 Inject adaptive runtime

- [ ] Inject `IAgentAdaptiveRuntimeService`.
- [ ] Keep ordinary behavior when mode is disabled.
- [ ] Create adaptive run on first adaptive turn.
- [ ] Restore compatible adaptive run on resume.
- [ ] Bind turn, step, and request IDs.

## 32.2 Before visible LLM request

Implement:

```text id="oo6oqt"
materialize StepRequest
→ normal onWillBeginStep hooks
→ adaptive prepareStep
→ internal search/evaluation/modeling loop
→ compact request decision
→ visible KC LLM request
```

- [ ] Allow internal operation requests without visible deltas.
- [ ] Enforce budgets.
- [ ] Enforce cancellation.
- [ ] Allow search to select a direct deterministic action without an unnecessary visible LLM call where safe.
- [ ] Preserve normal context projection and tool shaping.

## 32.3 Tool execution summary

Change `executeStepTools()` to return:

- [ ] finish reason;
- [ ] tool call IDs;
- [ ] tool names;
- [ ] args hashes;
- [ ] raw evidence references;
- [ ] model-facing result references;
- [ ] duration;
- [ ] stop-turn state;
- [ ] error state.

## 32.4 Authoritative post-step reconciliation

Insert after normal step persistence and before advisory hooks:

```text id="32rb6i"
finish KC step
→ adaptive observeStep
→ evidence commit
→ structure/conflict update
→ posterior update
→ search update
→ continuation/commit decision
→ advisory onDidFinishStep
```

- [ ] Do not swallow adaptive reconciliation failures.
- [ ] Fail closed on ledger failure.
- [ ] Fail closed on belief corruption.
- [ ] Enqueue continuation with existing `StepRequest` mechanisms.
- [ ] Preserve loop cancellation behavior.
- [ ] Preserve error-recovery handler behavior.
- [ ] Add ordinary-mode regression tests.
- [ ] Add adaptive-mode step-order tests.
- [ ] Add event-order tests.

## 32.5 Visible streaming

- [ ] Do not stream internal model requests.
- [ ] Do not stream candidate reasoning.
- [ ] Begin visible final response only after commit selection.
- [ ] Preserve visible tool-call streaming for real task actions.
- [ ] Ensure final-response token limit is applied before generation.

**Done when:** KC’s loop remains the sole owner of reality while Evolve controls internal evaluation and search through explicit fail-closed seams.

---

# 33. Add ephemeral evaluation agents and neutral batch execution

Modify:

```text id="hf7334"
session/agentLifecycle/agentLifecycle.ts
session/agentLifecycle/agentLifecycleService.ts
session/swarm/agentRunBatch.ts
session/swarm/sessionSwarmService.ts
```

Create:

```text id="ws2ebc"
session/agentBatch/
├── agentBatch.ts
├── agentBatchService.ts
└── agentRunBatch.ts
```

## 33.1 Ephemeral agents

- [ ] Add `persistence: 'durable' | 'ephemeral'`.
- [ ] Add evaluation labels.
- [ ] Create a normal Agent DI scope.
- [ ] Keep independent context.
- [ ] Do not register ephemeral agents as ordinary persisted conversational agents.
- [ ] Retain their evidence.
- [ ] Dispose them after evaluation.
- [ ] Abort them on cancellation.
- [ ] Enforce permissions and sandbox restrictions.
- [ ] Add lifecycle tests.

## 33.2 Neutral batch service

- [ ] Extract generic batch scheduling from swarm.
- [ ] Keep `AgentSwarmTool` behavior unchanged.
- [ ] Let stochastic evaluation consume structured per-agent results.
- [ ] Support concurrency limits.
- [ ] Support cancellation.
- [ ] Support timeouts.
- [ ] Support retries.
- [ ] Support rate-limit suspension.
- [ ] Record individual usage.
- [ ] Never render evaluator results as XML before aggregation.

## 33.3 Replicate independence

- [ ] Do not use `fork()` for independent replicates.
- [ ] Use fresh contexts.
- [ ] Record model and seed.
- [ ] Prevent accidental inherited hypotheses.
- [ ] Add contamination tests.

**Done when:** Evolve can run many isolated agent rollouts without polluting normal session metadata or relying on the model-facing swarm tool.

---

# 34. Enforce permissions and tool policy

- [ ] Preserve `manual`, `yolo`, and `auto` semantics.
- [ ] Never let `--evolve` imply approval.
- [ ] Apply ordinary permission gates to real actions.
- [ ] Apply sandbox capability gates to internal candidate actions.
- [ ] Treat candidate-workspace writes separately from live-workspace writes.
- [ ] Require approval for live consequential actions under manual mode.
- [ ] Permit regular tool calls under yolo exactly as KC currently does.
- [ ] Permit fully autonomous execution under auto exactly as KC currently does.
- [ ] Do not let internal prompts request permission escalation.
- [ ] Record permission state with every real action.
- [ ] Add permission-mode matrix tests.
- [ ] Add prompt-injection escalation tests.
- [ ] Add MCP and user-tool tests.
- [ ] Add additional-directory access tests.

**Done when:** Evolve changes decision quality, not the user’s authority boundary.

---

# 35. Handle all session lifecycle operations

## 35.1 Creation and resume

- [ ] Initialize adaptive services after session scope creation.
- [ ] Verify ledger before resuming search.
- [ ] Restore structural index.
- [ ] Restore conflicts.
- [ ] Restore causal rules.
- [ ] Restore beliefs.
- [ ] Restore search checkpoint.
- [ ] Detect incompatible protocol versions.
- [ ] Offer read-only diagnostics for newer unsupported artifacts.
- [ ] Fail adaptive resume clearly when execution cannot continue safely.

## 35.2 Close and reload

- [ ] Cancel internal requests.
- [ ] Cancel evaluations.
- [ ] Flush ledger.
- [ ] Flush signals.
- [ ] Flush checkpoints.
- [ ] Clean temporary workspaces.
- [ ] Preserve retained candidates.
- [ ] Dispose listeners.
- [ ] Add forced-close tests.
- [ ] Add reload tests.

## 35.3 Session fork

- [ ] Copy or reference immutable evidence only through the fork boundary.
- [ ] Exclude later evidence.
- [ ] Create fork-specific adaptive run lineage.
- [ ] Invalidate active search checkpoint.
- [ ] Rebuild baseline snapshot.
- [ ] Recompute active rules against forked context.
- [ ] Preserve candidate provenance.
- [ ] Add truncated-turn fork tests.

## 35.4 Undo and context clearing

- [ ] Mark affected active assumptions stale.
- [ ] Preserve immutable historical evidence.
- [ ] Recompute the active evidence view.
- [ ] Invalidate incompatible trajectory summaries.
- [ ] Invalidate search transpositions.
- [ ] Rebuild root state.
- [ ] Add undo tests.
- [ ] Add clear-context tests.
- [ ] Add import-context tests.

## 35.5 Additional directories

- [ ] Update snapshot roots.
- [ ] Update structural graph.
- [ ] Update sandbox mounts.
- [ ] Invalidate affected environment hashes.
- [ ] Reevaluate path permissions.
- [ ] Add session additional-directory tests.

## 35.6 Model changes

- [ ] Preserve evidence.
- [ ] Record new model binding.
- [ ] Invalidate model-specific policy/value calibration.
- [ ] Retain model-independent world models.
- [ ] Recompute role resolution.
- [ ] Add mid-session model-change tests.

## 35.7 Steering

- [ ] Version the user goal.
- [ ] Cancel no-longer-relevant evaluations.
- [ ] Preserve compatible evidence.
- [ ] Mark incompatible rules stale.
- [ ] Create a new search root.
- [ ] Record steering causally.
- [ ] Add rapid-steering tests.

**Done when:** every existing session operation has defined adaptive semantics and no operation leaves hidden stale search state active.

---

# 36. Add compact adaptive events and inspection APIs

## 36.1 Core events

Add:

```text id="1wm6ft"
adaptive.run.started
adaptive.phase.changed
adaptive.status.updated
adaptive.conflict.opened
adaptive.conflict.resolved
adaptive.commit.selected
adaptive.run.completed
adaptive.run.failed
```

Status includes:

- [ ] phase;
- [ ] evaluations completed;
- [ ] evaluations active;
- [ ] viable models;
- [ ] open conflicts;
- [ ] normalized posterior entropy;
- [ ] decision-weighted uncertainty;
- [ ] remaining budget fraction;
- [ ] verified candidate count.

Do not include:

- [ ] chain of thought;
- [ ] raw candidate prompts;
- [ ] hidden evaluation cases;
- [ ] full search tree;
- [ ] private model reasoning.

## 36.2 Node SDK

Modify:

```text id="1oua5p"
packages/node-sdk/src/events.ts
packages/node-sdk/src/types.ts
packages/node-sdk/src/v2/event-mapper.ts
packages/node-sdk/src/v2/session-wiring.ts
packages/node-sdk/src/sdk-rpc-client-v2.ts
```

- [ ] Add adaptive event types.
- [ ] Map native events explicitly.
- [ ] Do not rely on unsafe cast-through for new types.
- [ ] Add `getAdaptiveStatus`.
- [ ] Add `listAdaptiveRuns`.
- [ ] Add `getAdaptiveRunSummary`.
- [ ] Add `getAdaptiveConflicts`.
- [ ] Add `getAdaptiveEvidenceSummary`.
- [ ] Preserve remote-transport compatibility.
- [ ] Add SDK event tests.

The current mapper drops some v2-only events and casts remaining types into the closed legacy event union, so adaptive events require an explicit extension rather than accidental pass-through. fileciteturn183file0L1-L6

## 36.3 Klient and kap-server

- [ ] Add contracts for status and inspection.
- [ ] Add memory transport methods.
- [ ] Add server routes.
- [ ] Add event broadcast support.
- [ ] Add authorization checks.
- [ ] Add protocol tests.
- [ ] Keep hidden artifacts inaccessible.

## 36.4 Print mode

Modify:

```text id="u8admg"
apps/kimi-code/src/cli/v2/run-v2-print.ts
apps/kimi-code/src/cli/prompt-render.ts
```

- [ ] Suppress adaptive status in text mode.
- [ ] Emit structured status in `stream-json`.
- [ ] Emit terminal adaptive outcome.
- [ ] Preserve final textual answer.
- [ ] Add exact output tests.

## 36.5 TUI

- [ ] Add compact status display.
- [ ] Add phase display.
- [ ] Add cancellation action.
- [ ] Add budget display.
- [ ] Add concise failure display.
- [ ] Do not append status as chat messages.
- [ ] Add rendering tests.

## 36.6 Web

- [ ] Ensure web/kap paths compile with new events.
- [ ] Add status rendering when adaptive mode is programmatically enabled.
- [ ] Add no-op visual behavior when disabled.
- [ ] Add web event-store tests.

**Done when:** every host can observe adaptive progress without receiving private search internals or breaking existing event consumers.

---

# 37. Implement search checkpoints and recovery

Create:

```text id="xti95p"
session/searchCheckpoint/
├── searchCheckpoint.ts
├── searchCheckpointService.ts
├── searchSnapshot.ts
├── searchRecovery.ts
├── checkpointCompatibility.ts
└── configSection.ts
```

- [ ] Checkpoint after evaluation completion.
- [ ] Checkpoint after world-model insertion.
- [ ] Checkpoint after posterior update.
- [ ] Checkpoint before real action.
- [ ] Checkpoint after real action evidence.
- [ ] Checkpoint at commit selection.
- [ ] Include all content hashes.
- [ ] Include protocol versions.
- [ ] Include budget use.
- [ ] Include random-generator states.
- [ ] Include active evaluator states.
- [ ] Include frontier temperature.
- [ ] Include transposition metadata.
- [ ] Use atomic head update.
- [ ] Verify checkpoint against ledger head.
- [ ] Reject incompatible checkpoints.
- [ ] Recover from prior valid checkpoint when latest is incomplete.
- [ ] Never skip already committed evaluations.
- [ ] Add kill-at-every-boundary tests.

**Done when:** process termination does not force expensive completed evaluations to rerun or permit unrecorded results to influence search.

---

# 38. Implement final response planning and verification

Create:

```text id="dwieyb"
agent/adaptiveRuntime/finalResponsePlan.ts
agent/adaptiveRuntime/finalResponseVerifier.ts
agent/adaptiveRuntime/finalClaim.ts
```

- [ ] Build a structured response plan.
- [ ] Require changed files when files changed.
- [ ] Require decisive verification.
- [ ] Require unresolved material risk.
- [ ] Set maximum output tokens.
- [ ] Select direct evidence references.
- [ ] Generate the final response only after commit eligibility.
- [ ] Verify every claim after generation.
- [ ] Regenerate once when verification fails for correctable wording.
- [ ] Fail with a structured result when claims cannot be supported.
- [ ] Omit investigation history.
- [ ] Omit discarded candidates.
- [ ] Omit posterior calculations.
- [ ] Omit repeated logs.
- [ ] Add verbosity-evaluator tests.
- [ ] Add unsupported-claim adversarial tests.

**Done when:** the final response is short because the work is complete, not because verification details were suppressed.

---

# 39. Extend session export and diagnostics

Session export already recursively packages the session directory after flushing live agent wires. Adaptive data stored beneath the session directory will therefore be discovered automatically, but its services must be flushed and the manifest must describe it. fileciteturn170file0L1-L6

Modify:

```text id="ebbwzb"
app/sessionExport/sessionExport.ts
app/sessionExport/sessionExportService.ts
app/sessionExport/manifest.ts
app/sessionExport/zip.ts
```

## 39.1 Flush

- [ ] Flush adaptive ledger.
- [ ] Flush signal log.
- [ ] Flush belief log.
- [ ] Flush candidate lineage.
- [ ] Flush search checkpoint.
- [ ] Flush trajectory summaries.
- [ ] Verify ledger head.
- [ ] Verify artifact index.

## 39.2 Manifest

Add:

- [ ] adaptive protocol version;
- [ ] adaptive run count;
- [ ] latest run ID;
- [ ] latest run status;
- [ ] ledger-head hash;
- [ ] artifact count;
- [ ] candidate count;
- [ ] evaluation count;
- [ ] checkpoint version;
- [ ] redaction status;
- [ ] sandbox backend;
- [ ] baseline snapshot hash.

The existing manifest contract must be extended in both type and builder. fileciteturn171file0L1-L6 fileciteturn172file0L1-L6

## 39.3 Export safety

- [ ] Exclude hidden promotion inputs.
- [ ] Exclude credentials.
- [ ] Exclude transient candidate sandboxes unless explicitly retained.
- [ ] Include content-addressed artifacts referenced by exported evidence.
- [ ] Include a verification script or verifier command.
- [ ] Respect archive-size limits.
- [ ] Produce a clear error when full adaptive export exceeds configured maximum.
- [ ] Add full and summary export policies if necessary.
- [ ] Add export/import verification tests.

**Done when:** an exported session contains enough nonsecret data to audit and reconstruct every adaptive decision.

---

# 40. Add telemetry and operational metrics

- [ ] Adaptive run started.
- [ ] Adaptive run completed.
- [ ] Adaptive run failed.
- [ ] Adaptive phase duration.
- [ ] Evaluations by type.
- [ ] Evaluator failures.
- [ ] Replicate count.
- [ ] Candidate count.
- [ ] Candidate rejection reason.
- [ ] World-model population size.
- [ ] Posterior entropy.
- [ ] Decision-weighted information gain.
- [ ] Discovery temperature.
- [ ] Search nodes.
- [ ] Search depth.
- [ ] Transposition hit rate.
- [ ] Sandbox startup time.
- [ ] Workspace materialization time.
- [ ] Ledger write latency.
- [ ] Checkpoint recovery.
- [ ] Final response tokens.
- [ ] Unsupported-claim blocks.
- [ ] Total input/output tokens by model role.
- [ ] Total wall time.
- [ ] Total CPU time.
- [ ] Total disk use.

- [ ] Redact paths and sensitive source content according to existing telemetry policy.
- [ ] Keep evidence artifacts out of telemetry.
- [ ] Add telemetry schema tests.
- [ ] Add disabled-telemetry tests.

**Done when:** operational failures and cost regressions can be diagnosed without inspecting private source artifacts.

---

# 41. Add complete unit and property testing

## 41.1 Unit tests

Cover every exported function and service, including:

- [ ] canonical serialization;
- [ ] IDs and hashes;
- [ ] ledger append;
- [ ] ledger verification;
- [ ] artifact immutability;
- [ ] environment hashing;
- [ ] snapshot hashing;
- [ ] patch application;
- [ ] sandbox capability checks;
- [ ] evaluator registration;
- [ ] evaluator scheduling;
- [ ] cache keys;
- [ ] stochastic estimators;
- [ ] sequential stopping;
- [ ] multiple testing;
- [ ] structural parsing;
- [ ] incremental graph updates;
- [ ] signal reduction;
- [ ] conflict lifecycle;
- [ ] causal-rule equivalence;
- [ ] causal-rule lineage;
- [ ] scope promotion;
- [ ] world-model compilation;
- [ ] world-model limits;
- [ ] history replay;
- [ ] likelihood updates;
- [ ] posterior normalization;
- [ ] entropy;
- [ ] mutual information;
- [ ] decision sensitivity;
- [ ] belief tempering;
- [ ] action generation;
- [ ] PUCT;
- [ ] chance backup;
- [ ] progressive widening;
- [ ] transpositions;
- [ ] stopping;
- [ ] commit policy;
- [ ] prompt routing;
- [ ] memory selection;
- [ ] final-claim verification.

## 41.2 Property tests

- [ ] Ledger chain remains valid under arbitrary append sequences.
- [ ] Canonicalization is idempotent.
- [ ] Equal semantic rules hash equally.
- [ ] Posterior weights normalize.
- [ ] Eliminated models remain eliminated.
- [ ] Tempered weights never change true posterior.
- [ ] Chance-node probabilities normalize.
- [ ] Search backup is order independent where mathematically required.
- [ ] Signal reduction is idempotent.
- [ ] Snapshot reconstruction reproduces hash.
- [ ] Candidate workspaces never alter baseline.
- [ ] Reconciliation never drops user edits.
- [ ] Fixed seeds reproduce stochastic decisions.

## 41.3 Mutation tests

- [ ] Mutation testing for hard gates.
- [ ] Mutation testing for ledger verification.
- [ ] Mutation testing for permission checks.
- [ ] Mutation testing for sandbox checks.
- [ ] Mutation testing for final-claim verification.

**Done when:** critical correctness does not depend on tests that only exercise happy paths.

---

# 42. Add integration tests

Test the complete seams:

- [ ] CLI to bootstrap activation.
- [ ] Bootstrap to scoped-service activation.
- [ ] Loop to adaptive runtime.
- [ ] Adaptive runtime to evaluator.
- [ ] Evaluator to sandbox.
- [ ] Sandbox to candidate workspace.
- [ ] Tool executor to raw evidence.
- [ ] Evidence to ledger.
- [ ] Ledger to belief update.
- [ ] Belief update to search.
- [ ] Search to program evolution.
- [ ] Program evolution to evaluator cascade.
- [ ] Search to real KC action.
- [ ] Real action to structural listeners.
- [ ] Listeners to conflict reducer.
- [ ] Conflict reducer to search action proposals.
- [ ] Commit selection to live reconciliation.
- [ ] Commit selection to final response.
- [ ] Session close to flush.
- [ ] Session resume to recovery.
- [ ] Session export to adaptive manifest.
- [ ] SDK event mapping.
- [ ] TUI status rendering.
- [ ] Print JSON rendering.

**Done when:** every major subsystem boundary has a test that uses real production implementations on both sides.

---

# 43. Add end-to-end scenarios

Create full E2E tests for:

## 43.1 CLI modes

- [ ] `kimi --evolve`.
- [ ] `kimi --evolve --yolo`.
- [ ] `kimi --evolve --auto`.
- [ ] `kimi -p "..." --evolve`.
- [ ] `kimi --evolve --continue`.
- [ ] `kimi --evolve --session <id>`.
- [ ] invalid `--evolve --plan`.

## 43.2 Task classes

- [ ] localized bug;
- [ ] multi-file API change;
- [ ] cross-package change;
- [ ] persistence migration;
- [ ] wire schema change;
- [ ] event payload change;
- [ ] event-order race;
- [ ] generated manifest update;
- [ ] performance regression;
- [ ] flaky test;
- [ ] novel integration;
- [ ] ambiguous root cause;
- [ ] misleading initial hypothesis;
- [ ] required state-abstraction expansion.

## 43.3 Operational behavior

- [ ] dirty worktree;
- [ ] untracked files;
- [ ] symlinks;
- [ ] additional directories;
- [ ] user edits during run;
- [ ] cancellation;
- [ ] process kill;
- [ ] resume;
- [ ] steering;
- [ ] model switch;
- [ ] session fork;
- [ ] context undo;
- [ ] export;
- [ ] sandbox unavailable;
- [ ] provider unavailable;
- [ ] evaluator infrastructure failure;
- [ ] budget exhaustion;
- [ ] no viable model;
- [ ] unsupported final claim.

## 43.4 Ordinary regression

- [ ] ordinary v1 shell;
- [ ] ordinary v1 print;
- [ ] ordinary v2 shell;
- [ ] ordinary v2 print;
- [ ] ordinary session resume;
- [ ] ordinary swarm;
- [ ] ordinary background tasks;
- [ ] ordinary exports;
- [ ] ordinary permissions.

**Done when:** Evolve works as a product, not only as isolated library code.

---

# 44. Add adversarial security tests

- [ ] Candidate reads live workspace outside mount.
- [ ] Candidate writes live workspace.
- [ ] Candidate reads credentials.
- [ ] Candidate reads SSH agent.
- [ ] Candidate accesses cloud metadata.
- [ ] Candidate accesses network without capability.
- [ ] Candidate writes shared package cache.
- [ ] Candidate reads another candidate workspace.
- [ ] Candidate reads hidden promotion cases.
- [ ] Candidate tampers with evaluator output.
- [ ] Candidate tampers with ledger.
- [ ] Candidate forges evidence references.
- [ ] Candidate generates path traversal patch.
- [ ] Candidate creates symlink escape.
- [ ] Candidate forks excessive processes.
- [ ] Candidate emits excessive output.
- [ ] Candidate consumes excessive memory.
- [ ] Candidate loops indefinitely.
- [ ] Repository prompt injection attempts to disable Evolve.
- [ ] Repository prompt injection attempts to reveal internal prompts.
- [ ] Repository prompt injection attempts to claim tests passed.
- [ ] Tool output attempts to inject false evidence.
- [ ] Model proposal attempts to edit permissions.
- [ ] Model proposal attempts to edit promotion logic.
- [ ] Model proposal attempts to edit evaluator code.

**Done when:** all protected boundaries fail closed under deliberate attack.

---

# 45. Add performance and scale tests

- [ ] Large repository structural indexing.
- [ ] Incremental reindex latency.
- [ ] Ten thousand structural signals.
- [ ] Large causal-rule graph.
- [ ] Large candidate archive.
- [ ] Five hundred search nodes.
- [ ] Sixteen chance outcomes.
- [ ] Thirty-two stochastic replicates.
- [ ] Large evidence ledger.
- [ ] Large artifact set.
- [ ] Export size.
- [ ] Resume time.
- [ ] Checkpoint write latency.
- [ ] Candidate workspace creation latency.
- [ ] Sandbox startup latency.
- [ ] Tool evidence overhead.
- [ ] Ordinary-mode overhead with Evolve disabled.

Set explicit acceptance budgets:

- [ ] Evolve-disabled request overhead remains negligible.
- [ ] Incremental structural updates remain bounded.
- [ ] Ledger writes do not block visible streaming excessively.
- [ ] Search respects configured memory.
- [ ] Candidate cleanup keeps disk use bounded.
- [ ] Export produces a controlled error rather than memory exhaustion.

**Done when:** the system remains usable on real multi-package repositories and does not impose material cost when disabled.

---

# 46. Build the benchmark and promotion system

Create:

```text id="f5krhy"
benchmarks/evolve/
├── manifests/
├── tasks/
├── splits/
├── evaluators/
├── baselines/
├── reports/
└── scripts/
```

## 46.1 Locked suite

- [ ] 240 tasks.
- [ ] 24 TypeScript repositories.
- [ ] 10 tasks per repository.
- [ ] Six task families with 40 tasks each.
- [ ] Repository-level split:
  - [ ] 12 development;
  - [ ] 6 confirmation;
  - [ ] 6 hidden promotion.
- [ ] Near-duplicate detection.
- [ ] Immutable task hashes.
- [ ] Immutable split manifest.
- [ ] Hidden-case storage protection.

## 46.2 Baselines

- [ ] KC single attempt.
- [ ] KC compute-matched best-of-N.
- [ ] KC plus deterministic evaluation.
- [ ] KC plus evaluation and search.
- [ ] KC plus causal rules and search.
- [ ] Full Evolve.

## 46.3 Compute matching

Match:

- [ ] total model input tokens;
- [ ] total model output tokens;
- [ ] wall-clock limit;
- [ ] tool calls;
- [ ] evaluation processes;
- [ ] parallelism;
- [ ] model assignments.

## 46.4 Metrics

Primary:

- [ ] verified task success.

Secondary:

- [ ] wall time;
- [ ] tokens;
- [ ] tools;
- [ ] evaluation count;
- [ ] candidate count;
- [ ] tail failure;
- [ ] patch size;
- [ ] response length;
- [ ] checkpoint recovery;
- [ ] unsupported claims;
- [ ] corruption rate.

## 46.5 Promotion thresholds

- [ ] At least 10 percentage points over single-attempt KC.
- [ ] At least 5 percentage points over compute-matched best-of-N.
- [ ] Positive lower bound on paired 95% bootstrap interval.
- [ ] No increased repository corruption.
- [ ] No increased unsupported claims.
- [ ] Median final response no longer than base KC.
- [ ] At least 90% recovery under injected interruption.
- [ ] No protected-family regression beyond the locked tolerance.
- [ ] Two consecutive independent promotion windows.

## 46.6 Ablations

- [ ] Remove entropy frontier.
- [ ] Remove belief tempering.
- [ ] Remove program evolution.
- [ ] Remove causal-rule graph.
- [ ] Remove structural listeners.
- [ ] Remove stochastic evaluation.
- [ ] Remove tree search.
- [ ] Remove adaptive prompts.
- [ ] Remove adaptive memory.
- [ ] Compare results and cost.

**Done when:** the full implementation has measured, reproducible evidence that each major component contributes and the complete system meets promotion criteria.

---

# 47. Add documentation

Create:

```text id="mh2u36"
docs/evolve/
├── architecture.md
├── cli.md
├── configuration.md
├── evidence.md
├── evaluation.md
├── causal-rules.md
├── world-models.md
├── search.md
├── entropy.md
├── sandbox.md
├── recovery.md
├── security.md
├── export.md
├── benchmarking.md
└── troubleshooting.md
```

- [ ] Document `--evolve`.
- [ ] Document yolo/auto interaction.
- [ ] Document invocation-scoped activation.
- [ ] Document supported platforms.
- [ ] Document secure sandbox prerequisites.
- [ ] Document configuration.
- [ ] Document budgets.
- [ ] Document status phases.
- [ ] Document cancellation.
- [ ] Document resume.
- [ ] Document exports.
- [ ] Document evidence integrity.
- [ ] Document what candidates cannot access.
- [ ] Document failure codes.
- [ ] Document benchmark claims accurately.
- [ ] Do not expose hidden prompt internals as user instructions.
- [ ] Add changelog entries.
- [ ] Add SDK API documentation.

**Done when:** a user or maintainer can operate, debug, audit, and extend Evolve without reverse engineering the implementation.

---

# 48. Regenerate and validate generated artifacts

Run and commit:

```bash id="bfffol"
pnpm --filter @moonshot-ai/agent-core-v2 gen:contract-types
pnpm --filter @moonshot-ai/agent-core-v2 gen:config-manifest
pnpm --filter @moonshot-ai/agent-core-v2 gen:wire-manifest
pnpm --filter @moonshot-ai/agent-core-v2 gen:state-manifest
pnpm --filter @moonshot-ai/agent-core-v2 lint:imports
```

- [ ] Verify new config schemas appear.
- [ ] Verify new wire Ops appear.
- [ ] Verify new state keys appear.
- [ ] Verify contract types include adaptive events and APIs.
- [ ] Verify generated files are deterministic.
- [ ] Run generation twice and confirm no diff.
- [ ] Add generation snapshot tests where available.

**Done when:** a clean clone produces the committed generated artifacts byte-for-byte.

---

# 49. Run the complete local validation matrix

No GitHub Actions are required or added.

Run:

```bash id="py5tez"
pnpm install
pnpm sherif
pnpm build:packages
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm lint:pkg
```

Also run:

```bash id="v4e3sd"
pnpm --filter @moonshot-ai/agent-core-v2 test
pnpm --filter @moonshot-ai/program-evolution test
pnpm --filter @moonshot-ai/kimi-code test
pnpm --filter @moonshot-ai/kimi-code e2e
```

- [ ] Run sandbox backend tests on Linux.
- [ ] Run sandbox backend tests on Windows with WSL2.
- [ ] Run sandbox backend tests on macOS.
- [ ] Run the adaptive benchmark.
- [ ] Run ordinary regression tests.
- [ ] Run interruption/recovery tests.
- [ ] Run adversarial security tests.
- [ ] Run export verification.
- [ ] Run package publication checks.
- [ ] Run a clean-install smoke test.
- [ ] Run a built-binary smoke test, not only `tsx` development mode.

**Done when:** all commands succeed from a clean clone with no local uncommitted fixups.

---

# 50. Perform the final source audit

## 50.1 Search for unfinished implementation

Audit for:

```text id="eqeq8b"
TODO
FIXME
HACK
XXX
not implemented
not_implemented
throw new Error("stub")
throw new Error('stub')
return undefined // placeholder
return [] // placeholder
noop adaptive
temporary fallback
unsafe fallback
future work
follow-up
```

- [ ] Review every match manually.
- [ ] Remove all implementation placeholders.
- [ ] Permit unrelated preexisting matches only when documented.
- [ ] Confirm no Evolve service uses a no-op production binding.
- [ ] Confirm no supported Evolve SDK method reaches `getRpc()`’s `NOT_IMPLEMENTED` fallback.
- [ ] Confirm no evaluator returns a fabricated pass on infrastructure failure.
- [ ] Confirm no sandbox backend falls back to unrestricted execution.
- [ ] Confirm no missing program-evolution package silently disables Evolve.

## 50.2 Dependency audit

- [ ] No core-to-implementation dependency inversion.
- [ ] No circular package dependencies.
- [ ] No undeclared runtime dependencies.
- [ ] No test-only dependency required at runtime.
- [ ] No direct `process.env` access outside approved host boundaries.
- [ ] No direct live-workspace process execution from candidate evaluators.
- [ ] No candidate access to evaluator implementation.
- [ ] No hidden-case import path reachable from runtime candidates.

## 50.3 Persistence audit

- [ ] Every append log is flushed.
- [ ] Every atomic head is versioned.
- [ ] Every blob reference is reachable.
- [ ] Every recovery path verifies hashes.
- [ ] Every retained artifact has a reference.
- [ ] Every temporary workspace has cleanup.
- [ ] Every fork and resume path has adaptive semantics.
- [ ] Every export includes a valid adaptive manifest.

## 50.4 Behavior audit

Observe a completed run and confirm:

- [ ] CLI reports Evolve activation.
- [ ] Baseline snapshot exists.
- [ ] Structural graph exists.
- [ ] Multiple causal hypotheses exist where ambiguity is present.
- [ ] Multiple world models exist where epistemic discovery is used.
- [ ] Evaluations are selected by decision impact.
- [ ] Deterministic and stochastic evidence are represented differently.
- [ ] Entropy separates epistemic disagreement from noise.
- [ ] Belief tempering affects discovery only.
- [ ] Counterexamples cause model repair.
- [ ] Multi-file effects are traced.
- [ ] Background conflicts appear and resolve.
- [ ] Candidate patches run only in isolated workspaces.
- [ ] One real action is followed by replanning.
- [ ] Final commit passes hard gates.
- [ ] Final answer is concise and evidence-supported.
- [ ] Session resume continues without repeating completed work.
- [ ] Session export verifies.

## 50.5 Approval closure statement

The implementation is complete only when the final audit can truthfully state:

```text id="9n7w9k"
Evolve mode is fully implemented across CLI activation, KC bootstrap, evidence capture,
immutable persistence, isolated evaluation, deterministic and stochastic evaluators,
structural indexing, background conflict detection, causal-rule generalization,
executable world-model evolution, Bayesian belief updates, entropy-guided tree search,
adaptive prompting, long-horizon memory, real-action reconciliation, session lifecycle,
SDK and UI surfaces, export, recovery, security, testing, and benchmark promotion.

There are no required Evolve capabilities represented only by interfaces, stubs,
no-op services, hidden fallbacks, untested branches, or deferred follow-up work.
```
