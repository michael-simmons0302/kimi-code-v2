# Evolve implementation status ledger

This file records progress against `docs/evolve/implementation-todo.md`. It does not replace or expand that checklist.

Status values:

- `complete`: every checklist item in the section is implemented and its required verification exists.
- `partial`: substantive implementation exists, but one or more checklist items or verification gates remain open.
- `not started`: no substantive implementation has been accepted for the section.

| TODO section | Status | Evidence summary |
|---|---|---|
| 0. Completion contract | partial | Core implementation exists; repository-wide closure gates remain open. |
| 1. Implementation baseline | complete | Baseline, architecture version, protocol registry, status ledger, implementation branch, no-Actions rule, and package changeset are recorded. |
| 2. CLI activation | partial | Parsing, validation, routing, aliases, environment isolation, and a dedicated CLI test matrix exist; the tests have not yet been executed in the complete branch validation matrix. |
| 3. Bootstrap activation | partial | Host mode is copied into a genuinely frozen bootstrap snapshot with nested override tests; explicit native-print argument wiring, complete SDK diagnostics, and executed verification remain open. |
| 4. Packages and domains | partial | Core domains and program-evolution package exist and missing service registrations were corrected; package README, complete exports, package tests, and boundary verification remain open. |
| 5. Shared contracts and identifiers | partial | Shared identifiers, phases, budgets, and a documented production protocol registry exist; exhaustive runtime schemas and invalid-data tests remain open. |
| 6. Error domains | partial | All required adaptive domain registries, public facade aggregation, uniqueness tests, metadata tests, and serialization tests exist; the branch test run and production throw-site migration remain open. |
| 7. Configuration | partial | Adaptive schema work exists; full generated-manifest and cross-field validation closure remains open. |
| 8. Persistence layout | partial | Session-local adaptive stores exist; global promoted-artifact layout and complete GC/recovery tests remain open. |
| 9. Evidence ledger | partial | Hash-chained ledger exists; complete evidence graph queries, claim enforcement, and corruption matrix remain open. |
| 10. LLM provenance | partial | Request identity and hashing exist; exact final-boundary coverage and all retry tests remain open. |
| 11. Raw tool evidence | partial | Pre-truncation capture exists; full sensitivity and tool-specific coverage remain open. |
| 12. Bash/process evidence | partial | Structured process evaluation exists; complete Bash evidence envelopes remain open. |
| 13. Candidate workspaces | partial | Frozen baselines, isolated materialization, symlink and executable preservation, and dependency mounting exist; full reconciliation and platform tests remain open. |
| 14. Secure sandbox | partial | Linux, WSL2, and macOS backends exist with fail-closed probing and read-only dependency mounts; execution and adversarial matrices remain open. |
| 15. Evaluation registry | partial | Registry, scheduler, distinct specification/result protocols, and infrastructure-failure separation exist; full cache, recovery, and metadata closure remain open. |
| 16. Deterministic evaluators | partial | Process and sandbox command evaluators exist; the full evaluator catalog remains open. |
| 17. Stochastic evaluation | partial | Estimators and stopping exist; complete evaluator and attribution coverage remain open. |
| 18. Multiple testing | partial | Split and alpha-spending utilities exist; full leakage and p-hacking tests remain open. |
| 19. Counterexample minimization | partial | Minimization utilities exist; all minimizer families remain open. |
| 20. Code-structure graph | partial | Persistent TypeScript graph exists; full edge coverage and scale verification remain open. |
| 21. Signals and listeners | partial | Persistent queue and reducer exist; complete conflict and recovery tests remain open. |
| 22. Causal-rule DAG | partial | Persistent DAG exists; complete operation and promotion verification remains open. |
| 23. Executable world models | partial | Compilation, isolated execution, interface validation, population persistence, and beliefs exist; complete gates and adversarial tests remain open. |
| 24. Bayesian beliefs | partial | Log-space updates and deterministic elimination exist; exhaustive likelihood and persistence tests remain open. |
| 25. Entropy and discovery | partial | Posterior, predictive, conditional, epistemic, expected-posterior, decision-weighted, rule, conflict, projection, redundancy, leverage, budget-pressure, and frontier-score implementations plus numerical tests exist; the search runtime still needs to consume the shared frontier scorer and the test suite has not run. |
| 26. Calibration | partial | Some calibration primitives exist; complete persisted calibration subsystem remains open. |
| 27. Program evolution | partial | Proposal, repair, structured parse recovery, and persistent archive exist; full mutation/evaluation cascade and lifecycle closure remain open. |
| 28. Tree search | partial | Persistent PUCT search, chance outcomes, progressive widening, transpositions, and commit assessment exist; complete action set, shared frontier integration, receding-horizon verification, and tests remain open. |
| 29. Policy/value guidance | partial | Initial policy/value work exists; runtime promoted-checkpoint integration remains open. |
| 30. Prompt library | partial | Approved prompts, deterministic router, directive service, versions, and hashes exist; complete injection, compaction, and snapshot tests remain open. |
| 31. Adaptive memory | partial | Persistent evidence-backed summaries, deduplication, mandatory evidence preservation, utility-per-token selection, goal/structure invalidation, coordinator use, and direct tests exist; long-trajectory execution tests and the complete branch test run remain open. |
| 32. KC loop integration | partial | Memory-backed coordinator, deterministic hook priorities, fail-closed preparation/reconciliation bridge, continuation handling, and ordering tests exist; approved direct loop insertion, tool execution summaries, and full regression tests remain open. |
| 33. Ephemeral agents | partial | Neutral batch execution exists; true ephemeral lifecycle semantics remain open. |
| 34. Permissions | partial | Existing permission semantics are preserved in design; complete matrix tests remain open. |
| 35. Session lifecycle | partial | Some persistence/resume behavior exists; all lifecycle operations and tests remain open. |
| 36. Events and inspection | partial | Adaptive events exist; complete SDK/TUI/print/web/kap integration remains open. |
| 37. Checkpoints and recovery | partial | Search checkpoint persistence exists; full boundary interruption matrix remains open. |
| 38. Final response | partial | Evidence-backed claim verifier, changed-file and risk requirements, internal-detail blocking, token limit, one bounded correction gate, ledger recording, and direct tests exist; full coordinator integration and executed adversarial verification remain open. |
| 39. Export | partial | Adaptive files are session-local; explicit manifest, flush, redaction, and import verification remain open. |
| 40. Telemetry | partial | Some adaptive fields exist; complete metric schema remains open. |
| 41. Unit/property tests | partial | Direct tests now cover CLI activation, bootstrap mode, hook priorities, entropy/frontier semantics, adaptive memory, final response claims, final response correction, and adaptive error serialization; the full required coverage and execution remain open. |
| 42. Integration tests | not started | No complete production-seam matrix has been verified. |
| 43. End-to-end scenarios | not started | No complete E2E matrix has been verified. |
| 44. Adversarial security | not started | No complete adversarial matrix has been verified. |
| 45. Performance and scale | not started | No acceptance-budget run has been verified. |
| 46. Benchmark and promotion | not started | Locked corpus, baselines, ablations, and promotion run remain open. |
| 47. Documentation | partial | Baseline, protocol registry, status ledger, and TODO exist; operator documentation remains open. |
| 48. Generated artifacts | not started | Required generation commands have not been verified on the complete branch. |
| 49. Validation matrix | not started | Complete clean-clone validation has not passed. |
| 50. Final source audit | not started | Final audit is a terminal closure step. |

The authoritative remaining work is the set of unchecked boxes in `implementation-todo.md`, not prose added outside that document.
