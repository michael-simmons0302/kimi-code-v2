# Evolve protocol registry

The protocol identifiers below are the stable compatibility boundary for `evolve-architecture/1`.

| Domain | Protocol identifier | Owning contract |
|---|---|---|
| Architecture | `evolve-architecture/1` | `agent/adaptiveRuntime/adaptiveProtocol.ts` |
| Evidence ledger | `adaptive-ledger/1` | `session/evaluationLedger/evaluationLedger.ts` |
| Evidence graph | `adaptive-evidence-graph/1` | `session/evaluationLedger/evaluationLedger.ts` |
| Evaluation specification | `evaluation-spec/1` | `session/evaluation/evaluation.ts` |
| Evaluation result | `evaluation-result/1` | `session/evaluation/evaluation.ts` |
| Structural graph | `code-structure-graph/1` | `session/codeStructure/codeStructure.ts` |
| Structural signals | `structural-signals/1` | `session/structuralSignals/structuralSignals.ts` |
| Causal rules | `causal-rule/1` | `agent/causalRuleGraph/causalRuleGraph.ts` |
| Executable world models | `world-model-module/1` | `agent/worldModel/worldModel.ts` |
| World-model store | `world-model-store/1` | `agent/worldModel/worldModelService.ts` |
| Search checkpoint | `adaptive-search-checkpoint/1` | `agent/testTimeSearch/testTimeSearch.ts` |
| Adaptive prompts | `adaptive-prompt/1` | `agent/adaptivePrompt/adaptivePromptLibrary.ts` |
| Candidate workspace snapshot | `candidate-workspace/1` | `session/candidateWorkspace/candidateWorkspace.ts` |
| Sandbox execution | `evaluation-sandbox/1` | `session/evaluationSandbox/evaluationSandbox.ts` |
| Program archive | `program-archive/1` | `packages/program-evolution/src/archive/programArchive.ts` |
| Benchmark manifest | `evolve-benchmark-manifest/1` | `benchmarks/evolve/manifests/` |

## Compatibility rules

1. Persisted readers must validate protocol identifiers before consuming data.
2. A reader may reject a newer incompatible protocol, but may not reinterpret it as the current version.
3. Any incompatible persisted-shape change requires a new protocol identifier and an explicit migration or read-only failure mode.
4. Protocol identifiers are constants in production contracts, not documentation-only labels.
5. Hidden promotion inputs and evaluator internals are not part of any candidate-visible protocol.
