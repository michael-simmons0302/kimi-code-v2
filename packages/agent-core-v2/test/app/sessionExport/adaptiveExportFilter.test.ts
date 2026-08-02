import { join } from 'pathe';
import { describe, expect, it } from 'vitest';

import type { AdaptiveExportPreparation } from '#/app/sessionExport/adaptiveExport';
import { filterAdaptiveExportFiles } from '#/app/sessionExport/adaptiveExportFilter';

function preparation(hash: string): AdaptiveExportPreparation {
  return {
    manifest: {
      protocol: 'adaptive-export-manifest/1',
      architectureVersion: 'evolve-architecture/1',
      adaptiveRunCount: 1,
      ledgerHeadHash: 'a'.repeat(64),
      ledgerRecords: 1,
      artifactCount: 2,
      exportedArtifactCount: 1,
      redactedArtifactCount: 1,
      candidateCount: 1,
      evaluationCount: 1,
      checkpointCount: 1,
      checkpointProtocol: 'adaptive-search-checkpoint/1',
      redaction: {
        protectedEvaluatorArtifactsExcluded: true,
        credentialsExcluded: true,
        transientWorkspacesExcluded: true,
        hiddenPromotionInputsExcluded: true,
      },
      verification: {
        ledgerValid: true,
        artifactIndexValid: true,
        checkpointIndexValid: true,
      },
      generatedAtSequence: 1,
      manifestHash: 'b'.repeat(64),
    },
    excludedArtifactHashes: [hash],
    retainedArtifactHashes: [],
    excludedPathFragments: ['adaptive/custom-hidden'],
  };
}

describe('filterAdaptiveExportFiles', () => {
  it('physically excludes transient, credential-like, hidden, and protected entries', () => {
    const root = '/sessions/s1';
    const protectedHash = '2'.repeat(64);
    const ordinary = join(root, 'adaptive', 'ledger', 'ledger.jsonl');
    const files = [
      ordinary,
      join(root, 'adaptive', 'workspaces', 'candidate', 'src.ts'),
      join(root, 'adaptive', 'ephemeral-agents', 'agent.json'),
      join(root, 'adaptive', 'custom-hidden', 'promotion.json'),
      join(root, 'adaptive', 'artifacts', protectedHash),
      join(root, '.env.production'),
      join(root, 'nested', 'credentials.json'),
      join(root, 'nested', 'private-key.pem'),
    ];

    const result = filterAdaptiveExportFiles(
      root,
      files,
      preparation(protectedHash),
    );

    expect(result.included).toEqual([ordinary]);
    expect(result.excluded.filter(({ reason }) => reason === 'transient-path')).toHaveLength(3);
    expect(
      result.excluded.filter(({ reason }) => reason === 'credential-like-file'),
    ).toHaveLength(3);
    expect(result.excluded.filter(({ reason }) => reason === 'protected-artifact')).toHaveLength(1);
  });

  it('rejects paths that escape the session root', () => {
    expect(() => filterAdaptiveExportFiles('/sessions/s1', ['/sessions/other/a'], undefined))
      .toThrow('escapes the session directory');
  });

  it('does not remove ordinary files when adaptive mode was never used', () => {
    const root = '/sessions/s1';
    const file = join(root, 'wire', 'events.jsonl');
    expect(filterAdaptiveExportFiles(root, [file], undefined)).toEqual({
      included: [file],
      excluded: [],
    });
  });
});
