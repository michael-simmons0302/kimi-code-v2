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
| 2. CLI activation | partial | Parsing and routing exist; the complete CLI test matrix remains open. |
| 3. Bootstrap activation | partial | Frozen host mode exists; complete SDK and diagnostics tests remain open. |
| 4. Packages and domains | partial | Core domains and program-evolution package exist; package README, complete exports, tests, and boundary verification remain open. |
| 5. Shared contracts and identifiers | partial | Shared identifiers, phases, budgets, and protocol constants exist; exhaustive schemas and invalid-data tests remain open. |
| 6. Error domains | partial | Adaptive error work exists locally in the implementation history; final aggregation and tests remain open. |
| 7. Configuration | partial | Adaptive schema work exists; full generated-manifest and cross-field validation closure remains open. |
| 8. Persistence layout | partial | Session-local adaptive stores exist; global promoted-artifact layout and complete GC/recovery tests remain open. |
| 9. Evidence ledger | partial | Hash-chained ledger exists; complete evidence graph queries, claim enforcement, and corruption matrix remain open. |
| 10. LLM provenance | partial | Request identity and hashing exist; exact final-boundary coverage and all retry tests remain open. |
| 11. Raw tool evidence | partial | Pre-truncation capture exists; full sensitivity and tool-specific coverage remain open. |
| 12. Bash/process evidence | partial | Structured process evaluation exists; complete Bash evidence envelopes remain open. |
| 13. Candidate workspaces | partial | Frozen baselines and isolated materialization exist; full reconciliation and platform tests remain open. |
| 14. Secure sandbox | partial | Linux, WSL2, and macOS backends exist; execution and adversarial matrix remain open. |
| 15. Evaluation registry | partial | Registry and scheduler exist; full cache, recovery, and metadata closure remain open. |
| 16. Deterministic evaluators | partial | Process and sandbox command evaluators exist; the full evaluator catalog remains open. |
| 17. Stochastic evaluation | partial | Estimators and stopping exist; complete evaluator and attribution coverage remain open. |
| 18. Multiple testing | partial | Split and alpha-spending utilities exist; full leakage and p-hacking tests remain open. |
| 19. Counterexample minimization | partial | Minimization utilities exist; all minimizer families remain open. |
| 20. Code-structure graph | partial | Persistent TypeScript graph exists; full edge coverage and scale verification remain open. |
| 21. Signals and listeners | partial | Persistent queue and reducer exist; complete conflict and recovery tests remain open. |
| 22. Causal-rule DAG | partial | Persistent DAG exists; complete operation and promotion verification remains open. |
| 23. Executable world models | partial | Compilation, isolation, population, and beliefs exist; complete gates and adversarial tests remain open. |
| 24. Bayesian beliefs | partial | Log-space updates and elimination exist; exhaustive likelihood and persistence tests remain open. |
| 25. Entropy and discovery | partial | Required entropy mathematics exists; complete numerical and calibration tests remain open. |
| 26. Calibration | partial | Some calibration primitives exist; complete persisted calibration subsystem remains open. |
| 27. Program evolution | partial | Proposal, repair, and archive exist; full mutation/evaluation cascade and lifecycle closure remain open. |
| 28. Tree search | partial | PUCT search exists; complete action set, receding-horizon integration, and tests remain open. |
| 29. Policy/value guidance | partial | Initial policy/value work exists; runtime promoted-checkpoint integration remains open. |
| 30. Prompt library | partial | Approved prompts and router exist; complete injection and snapshot tests remain open. |
| 31. Adaptive memory | partial | Initial memory work exists; complete selection, validation, and long-trajectory tests remain open. |
| 32. KC loop integration | partial | Coordinator work exists; authoritative ordering and full regression tests remain open. |
| 33. Ephemeral agents | partial | Neutral batch execution exists; true ephemeral lifecycle semantics remain open. |
| 34. Permissions | partial | Existing permission semantics are preserved in design; complete matrix tests remain open. |
| 35. Session lifecycle | partial | Some persistence/resume behavior exists; all lifecycle operations and tests remain open. |
| 36. Events and inspection | partial | Adaptive events exist; complete SDK/TUI/print/web/kap integration remains open. |
| 37. Checkpoints and recovery | partial | Search checkpoint persistence exists; full boundary interruption matrix remains open. |
| 38. Final response | partial | Initial claim-verification work exists; complete generation and adversarial tests remain open. |
| 39. Export | partial | Adaptive files are session-local; explicit manifest, flush, redaction, and import verification remain open. |
| 40. Telemetry | partial | Some adaptive fields exist; complete metric schema remains open. |
| 41. Unit/property tests | partial | Some unit tests exist; complete required coverage remains open. |
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
