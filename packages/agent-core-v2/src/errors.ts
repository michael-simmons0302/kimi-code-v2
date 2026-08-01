/**
 * Error facade — aggregates every domain's error contribution into the unified
 * `ErrorCodes` const and re-exports the error primitives. Importing this
 * module registers every domain's codes.
 */

import { CoreErrors } from '#/_base/errors/codes';
import { AdaptiveMemoryErrors } from '#/agent/adaptiveMemory/errors';
import { AdaptivePromptErrors } from '#/agent/adaptivePrompt/errors';
import { AdaptiveRuntimeErrors } from '#/agent/adaptiveRuntime/errors';
import { CausalRuleErrors } from '#/agent/causalRuleGraph/errors';
import { FullCompactionErrors } from '#/agent/fullCompaction/errors';
import { GoalErrors } from '#/agent/goal/errors';
import { LoopErrors } from '#/agent/loop/errors';
import { ProfileErrors } from '#/agent/profile/errors';
import { PromptErrors } from '#/agent/prompt/errors';
import { TaskErrors } from '#/agent/task/errors';
import { TestTimeSearchErrors } from '#/agent/testTimeSearch/errors';
import { UsageErrors } from '#/agent/usage/errors';
import { WorldModelErrors } from '#/agent/worldModel/errors';
import { AuthErrors } from '#/app/auth/errors';
import { ConfigErrors } from '#/app/config/errors';
import { FileErrors } from '#/app/file/fileService';
import { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
import { MessageLegacyErrors } from '#/app/messageLegacy/errors';
import { PluginErrors } from '#/app/plugin/errors';
import { SessionExportErrors } from '#/app/sessionExport/errors';
import { SkillErrors } from '#/app/skillCatalog/errors';
import { WorkspaceErrors } from '#/app/workspace/errors';
import { ProtocolErrors } from '#/kosong/protocol/errors';
import { ModelCatalogErrors } from '#/kosong/model/errors';
import { McpErrors } from '#/mcpCore/errors';
import { OsFsErrors } from '#/os/interface/hostFsErrors';
import { OsProcessErrors } from '#/os/interface/hostProcess';
import { TerminalErrors } from '#/os/interface/terminalErrors';
import { StorageErrors } from '#/persistence/interface/storage';
import { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
import { CandidateWorkspaceErrors } from '#/session/candidateWorkspace/errors';
import { CodeStructureErrors } from '#/session/codeStructure/errors';
import { EvaluationErrors } from '#/session/evaluation/errors';
import { EvaluationLedgerErrors } from '#/session/evaluationLedger/errors';
import { EvaluationSandboxErrors } from '#/session/evaluationSandbox/errors';
import { SessionErrors } from '#/session/errors';
import { StructuralSignalErrors } from '#/session/structuralSignals/errors';
import { WorldModelEvolutionErrors } from '#/session/worldModelEvolution/errors';
import { FsErrors } from '#/workspace/workspaceFs/internal/errors';
import { WireErrors } from '#/wire/errors';

export * from '#/_base/errors/codes';
export * from '#/_base/errors/errorMessage';
export * from '#/_base/errors/errors';
export * from '#/_base/errors/serialize';
export * from '#/_base/errors/unexpectedError';
export { AdaptiveMemoryErrors } from '#/agent/adaptiveMemory/errors';
export { AdaptivePromptErrors } from '#/agent/adaptivePrompt/errors';
export { AdaptiveRuntimeErrors } from '#/agent/adaptiveRuntime/errors';
export { CausalRuleErrors } from '#/agent/causalRuleGraph/errors';
export { FullCompactionErrors } from '#/agent/fullCompaction/errors';
export { GoalErrors } from '#/agent/goal/errors';
export { LoopErrors } from '#/agent/loop/errors';
export { ProfileErrors } from '#/agent/profile/errors';
export { PromptErrors } from '#/agent/prompt/errors';
export { TaskErrors } from '#/agent/task/errors';
export { TestTimeSearchErrors } from '#/agent/testTimeSearch/errors';
export { UsageErrors } from '#/agent/usage/errors';
export { WorldModelErrors } from '#/agent/worldModel/errors';
export { AuthErrors } from '#/app/auth/errors';
export { ConfigErrors } from '#/app/config/errors';
export { FileErrors } from '#/app/file/fileService';
export { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
export { MessageLegacyErrors } from '#/app/messageLegacy/errors';
export { PluginErrors } from '#/app/plugin/errors';
export { SessionExportErrors } from '#/app/sessionExport/errors';
export { SkillErrors } from '#/app/skillCatalog/errors';
export { WorkspaceErrors } from '#/app/workspace/errors';
export { ProtocolErrors } from '#/kosong/protocol/errors';
export { ModelCatalogErrors } from '#/kosong/model/errors';
export { McpErrors } from '#/mcpCore/errors';
export { OsFsErrors } from '#/os/interface/hostFsErrors';
export { OsProcessErrors } from '#/os/interface/hostProcess';
export { TerminalErrors } from '#/os/interface/terminalErrors';
export { StorageErrors } from '#/persistence/interface/storage';
export { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
export { CandidateWorkspaceErrors } from '#/session/candidateWorkspace/errors';
export { CodeStructureErrors } from '#/session/codeStructure/errors';
export { EvaluationErrors } from '#/session/evaluation/errors';
export { EvaluationLedgerErrors } from '#/session/evaluationLedger/errors';
export { EvaluationSandboxErrors } from '#/session/evaluationSandbox/errors';
export { SessionErrors } from '#/session/errors';
export { StructuralSignalErrors } from '#/session/structuralSignals/errors';
export { WorldModelEvolutionErrors } from '#/session/worldModelEvolution/errors';
export { FsErrors } from '#/workspace/workspaceFs/internal/errors';
export { WireErrors } from '#/wire/errors';

export const ErrorCodes = {
  ...CoreErrors.codes,
  ...AdaptiveMemoryErrors.codes,
  ...AdaptivePromptErrors.codes,
  ...AdaptiveRuntimeErrors.codes,
  ...CausalRuleErrors.codes,
  ...FullCompactionErrors.codes,
  ...GoalErrors.codes,
  ...LoopErrors.codes,
  ...ProfileErrors.codes,
  ...PromptErrors.codes,
  ...TaskErrors.codes,
  ...TestTimeSearchErrors.codes,
  ...UsageErrors.codes,
  ...WorldModelErrors.codes,
  ...AuthErrors.codes,
  ...ConfigErrors.codes,
  ...FileErrors.codes,
  ...ModelsDevImportErrors.codes,
  ...MessageLegacyErrors.codes,
  ...PluginErrors.codes,
  ...SessionExportErrors.codes,
  ...SkillErrors.codes,
  ...WorkspaceErrors.codes,
  ...ProtocolErrors.codes,
  ...ModelCatalogErrors.codes,
  ...McpErrors.codes,
  ...OsFsErrors.codes,
  ...OsProcessErrors.codes,
  ...TerminalErrors.codes,
  ...StorageErrors.codes,
  ...AgentLifecycleErrors.codes,
  ...CandidateWorkspaceErrors.codes,
  ...CodeStructureErrors.codes,
  ...EvaluationErrors.codes,
  ...EvaluationLedgerErrors.codes,
  ...EvaluationSandboxErrors.codes,
  ...SessionErrors.codes,
  ...StructuralSignalErrors.codes,
  ...WorldModelEvolutionErrors.codes,
  ...FsErrors.codes,
  ...WireErrors.codes,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
