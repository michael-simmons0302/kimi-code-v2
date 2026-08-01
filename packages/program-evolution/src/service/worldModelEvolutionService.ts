import { createHash } from 'node:crypto';

import { LifecycleScope, ScopeActivation, registerScopedService } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import { INTERNAL_ADAPTIVE_PROMPTS } from '@moonshot-ai/agent-core-v2/agent/adaptivePrompt/adaptivePromptLibrary';
import { IAgentLLMRequesterService } from '@moonshot-ai/agent-core-v2/agent/llmRequester/llmRequester';
import { requestIdForTrace } from '@moonshot-ai/agent-core-v2/kosong/contract/requestTrace';
import {
  IAgentWorldModelEvolutionService,
  type WorldModelCandidateBundle,
  type WorldModelEvolutionInput,
  type WorldModelEvolutionKind,
  type WorldModelEvolutionResult,
} from '@moonshot-ai/agent-core-v2/session/worldModelEvolution/worldModelEvolution';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_CANDIDATES_PER_REQUEST = 16;

export class AgentWorldModelEvolutionService implements IAgentWorldModelEvolutionService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLLMRequesterService private readonly requester: IAgentLLMRequesterService,
  ) {}

  async evolve(
    input: WorldModelEvolutionInput,
    signal?: AbortSignal,
  ): Promise<WorldModelEvolutionResult> {
    validateInput(input);
    const prompt = promptFor(input.kind);
    const request = this.requester.start(
      {
        source: {
          type: 'operation',
          requestKind: prompt.id,
          logFields: {
            adaptive: true,
            evolutionKind: input.kind,
            promptVersion: prompt.version,
          },
        },
        systemPrompt: prompt.content,
        tools: [],
        messages: [userMessage(requestPayload(input))],
        maxOutputSize: 65_536,
      },
      undefined,
      signal,
    );
    const first = await request.result;
    const firstText = responseText(first.message.content);
    let candidates: readonly WorldModelCandidateBundle[];
    try {
      candidates = parseCandidates(firstText, input);
    } catch (firstError) {
      const repair = this.requester.start(
        {
          source: {
            type: 'operation',
            requestKind: `${prompt.id}.parse-repair`,
            logFields: {
              adaptive: true,
              evolutionKind: input.kind,
              promptVersion: prompt.version,
              parseRepair: true,
            },
          },
          systemPrompt: `${prompt.content}\n\nThe prior response was not valid for the required JSON schema. Return corrected JSON only.`,
          tools: [],
          messages: [
            userMessage({
              request: requestPayload(input),
              invalidResponse: firstText,
              validationError: firstError instanceof Error ? firstError.message : String(firstError),
              requiredShape: candidateShapeDescription(),
            }),
          ],
          maxOutputSize: 65_536,
        },
        undefined,
        signal,
      );
      const repaired = await repair.result;
      candidates = parseCandidates(responseText(repaired.message.content), input);
    }
    return {
      kind: input.kind,
      candidates,
      requestId: requestIdForTrace(request.trace),
      providerTraceId: request.trace.traceId,
    };
  }
}

function promptFor(kind: WorldModelEvolutionKind): {
  readonly id: string;
  readonly version: number;
  readonly content: string;
} {
  switch (kind) {
    case 'repair':
      return INTERNAL_ADAPTIVE_PROMPTS.worldModelRepair;
    case 'propose':
    case 'recombine':
    case 'expand-state-abstraction':
    case 'adversarial-alternative':
    case 'simplify':
      return INTERNAL_ADAPTIVE_PROMPTS.worldModelProposal;
  }
}

function requestPayload(input: WorldModelEvolutionInput): unknown {
  return {
    objective: input.objective,
    evolutionKind: input.kind,
    observations: input.observations,
    counterexamples: input.counterexamples,
    conflicts: input.conflicts,
    availableRuleIds: input.ruleIds,
    allowedParentCandidateIds: input.parentCandidateIds,
    parentCandidates: input.parentCandidates?.map((candidate) => ({
      manifest: candidate.manifest,
      source: candidate.source,
      ruleIds: candidate.ruleIds,
      status: candidate.status,
      rejectionReason: candidate.rejectionReason,
    })),
    contracts: {
      ruleGraphHash: input.ruleGraphHash,
      stateSchemaHash: input.stateSchemaHash,
      actionSchemaHash: input.actionSchemaHash,
      observationSchemaHash: input.observationSchemaHash,
      evidenceHead: input.evidenceHead,
    },
    maximumCandidates: Math.min(input.maximumCandidates, MAX_CANDIDATES_PER_REQUEST),
    requiredShape: candidateShapeDescription(),
  };
}

function userMessage(payload: unknown) {
  return {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    toolCalls: [],
  };
}

function responseText(content: readonly unknown[]): string {
  return content
    .map((part) =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('')
    .trim();
}

function parseCandidates(
  text: string,
  input: WorldModelEvolutionInput,
): readonly WorldModelCandidateBundle[] {
  if (text.length === 0) throw new Error('Evolution response is empty.');
  if (text.startsWith('```')) throw new Error('Evolution response must be raw JSON without a code fence.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Evolution response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['candidates'])) {
    throw new Error('Evolution response must be an object containing candidates[].');
  }
  const maximum = Math.min(input.maximumCandidates, MAX_CANDIDATES_PER_REQUEST);
  if (parsed['candidates'].length === 0 || parsed['candidates'].length > maximum) {
    throw new Error(`Evolution response must contain between 1 and ${maximum} candidates.`);
  }
  const allowedRules = new Set(input.ruleIds);
  const allowedParents = new Set(input.parentCandidateIds);
  const seenSources = new Set<string>();
  return parsed['candidates'].map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Candidate ${index} is not an object.`);
    const source = requiredString(raw, 'source', index);
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
      throw new Error(`Candidate ${index} source exceeds ${MAX_SOURCE_BYTES} bytes.`);
    }
    const sourceHash = createHash('sha256').update(source).digest('hex');
    if (seenSources.has(sourceHash)) throw new Error(`Candidate ${index} duplicates another source.`);
    seenSources.add(sourceHash);
    const ruleIds = requiredStringArray(raw, 'ruleIds', index);
    for (const ruleId of ruleIds) {
      if (!allowedRules.has(ruleId as never)) throw new Error(`Candidate ${index} references unavailable rule ${ruleId}.`);
    }
    const parentCandidateIds = requiredStringArray(raw, 'parentCandidateIds', index);
    for (const candidateId of parentCandidateIds) {
      if (!allowedParents.has(candidateId as never)) {
        throw new Error(`Candidate ${index} references unavailable parent ${candidateId}.`);
      }
    }
    if (typeof raw['deterministic'] !== 'boolean') {
      throw new Error(`Candidate ${index} deterministic must be boolean.`);
    }
    const supportedEvaluatorIds = requiredStringArray(raw, 'supportedEvaluatorIds', index);
    const rationaleSummary = requiredString(raw, 'rationaleSummary', index);
    if (rationaleSummary.length > 2_000) throw new Error(`Candidate ${index} rationaleSummary is too long.`);
    return {
      source,
      ruleIds: ruleIds as WorldModelCandidateBundle['ruleIds'],
      parentCandidateIds: parentCandidateIds as WorldModelCandidateBundle['parentCandidateIds'],
      deterministic: raw['deterministic'],
      supportedEvaluatorIds,
      rationaleSummary,
    };
  });
}

function validateInput(input: WorldModelEvolutionInput): void {
  if (input.objective.trim().length === 0) throw new Error('Evolution objective cannot be empty.');
  if (!Number.isInteger(input.maximumCandidates) || input.maximumCandidates <= 0) {
    throw new Error('maximumCandidates must be a positive integer.');
  }
}

function candidateShapeDescription(): unknown {
  return {
    candidates: [
      {
        source: 'TypeScript source assigning the complete implementation to globalThis.worldModel',
        ruleIds: ['existing causal rule IDs only'],
        parentCandidateIds: ['allowed parent candidate IDs only'],
        deterministic: true,
        supportedEvaluatorIds: ['evaluator IDs'],
        rationaleSummary: 'brief behavioral summary, not hidden reasoning',
      },
    ],
  };
}

function requiredString(record: Record<string, unknown>, key: string, index: number): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Candidate ${index} ${key} must be a non-empty string.`);
  }
  return value;
}

function requiredStringArray(
  record: Record<string, unknown>,
  key: string,
  index: number,
): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Candidate ${index} ${key} must be a string array.`);
  }
  return [...new Set(value)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentWorldModelEvolutionService,
  AgentWorldModelEvolutionService,
  ScopeActivation.OnScopeCreated,
  'worldModelEvolution',
);
