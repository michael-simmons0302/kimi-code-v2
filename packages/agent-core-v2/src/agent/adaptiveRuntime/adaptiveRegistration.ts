import {
  ScopeActivation,
  withScopedRegistrationActivation,
} from '#/_base/di/scope';

await withScopedRegistrationActivation(ScopeActivation.OnDemand, async () => {
  await Promise.all([
    import('#/agent/adaptiveRuntime/adaptiveSchemaRegistry'),
    import('#/agent/adaptiveRuntime/adaptiveConfigService'),
    import('#/agent/adaptiveRuntime/adaptiveRuntimeService'),
    import('#/agent/adaptiveRuntime/adaptiveCoordinatorService'),
    import('#/agent/adaptiveRuntime/adaptiveFinalResponseGateService'),
    import('#/agent/adaptiveRuntime/finalResponseVerifierService'),
    import('#/agent/adaptivePrompt/adaptivePromptService'),
    import('#/agent/adaptivePrompt/adaptiveDirectiveService'),
    import('#/agent/adaptiveMemory/adaptiveMemoryService'),
    import('#/agent/evaluationEvidence/evaluationEvidenceService'),
    import('#/agent/causalRuleGraph/causalRuleGraphService'),
    import('#/agent/worldModel/worldModelCalibrationService'),
    import('#/agent/worldModel/worldModelService'),
    import('#/agent/testTimeSearch/searchPolicyValueService'),
    import('#/agent/testTimeSearch/testTimeSearchService'),
    import('#/session/adaptivePersistence/adaptivePersistenceService'),
    import('#/session/adaptiveInspection/adaptiveInspectionService'),
    import('#/session/evaluationLedger/evaluationLedgerService'),
    import('#/session/evaluationLedger/evidenceGraphService'),
    import('#/session/evaluation/evaluationRegistryService'),
    import('#/session/evaluation/evaluationCacheService'),
    import('#/session/evaluation/evaluationService'),
    import('#/session/evaluation/processEvaluatorService'),
    import('#/session/evaluation/sandboxCommandEvaluatorService'),
    import('#/session/codeStructure/codeStructureService'),
    import('#/session/structuralSignals/structuralSignalsService'),
    import('#/session/candidateWorkspace/candidateWorkspaceService'),
    import('#/session/evaluationSandbox/evaluationSandboxService'),
    import('#/session/searchCheckpoint/searchCheckpointService'),
    import('#/app/sessionExport/adaptiveExportService'),
  ]);
});

export {};
