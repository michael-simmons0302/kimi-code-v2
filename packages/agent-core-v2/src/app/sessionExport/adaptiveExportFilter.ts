import { basename, relative } from 'pathe';

import type { AdaptiveExportPreparation } from './adaptiveExport';

const DEFAULT_EXCLUDED_FRAGMENTS = Object.freeze([
  'adaptive/workspaces/',
  'adaptive/ephemeral-agents/',
  'adaptive/hidden-promotion/',
  'adaptive/promotion/hidden/',
  'adaptive/protected-evaluator/',
  'adaptive/evaluations/hidden/',
  'credentials/',
]);

const SECRET_FILE_PATTERNS = Object.freeze([
  /^\.env(?:\..+)?$/i,
  /^(?:credentials|secrets?|tokens?|oauth|auth)\.json$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
]);

export interface AdaptiveExportFilterResult {
  readonly included: readonly string[];
  readonly excluded: readonly {
    readonly path: string;
    readonly reason:
      | 'transient-path'
      | 'credential-like-file'
      | 'protected-artifact';
  }[];
}

export function filterAdaptiveExportFiles(
  sessionDir: string,
  files: readonly string[],
  preparation: AdaptiveExportPreparation | undefined,
): AdaptiveExportFilterResult {
  const excludedArtifactHashes = new Set(
    preparation?.excludedArtifactHashes.map((hash) => hash.toLowerCase()) ?? [],
  );
  const pathFragments = [
    ...DEFAULT_EXCLUDED_FRAGMENTS,
    ...(preparation?.excludedPathFragments ?? []),
  ].map(normalizeFragment);
  const included: string[] = [];
  const excluded: AdaptiveExportFilterResult['excluded'][number][] = [];

  for (const file of files) {
    const relativePath = normalizeRelativePath(relative(sessionDir, file));
    if (relativePath.startsWith('../') || relativePath === '..') {
      throw new Error(`Session export file escapes the session directory: ${file}`);
    }
    if (pathFragments.some((fragment) => relativePath.includes(fragment))) {
      excluded.push({ path: file, reason: 'transient-path' });
      continue;
    }
    if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(basename(relativePath)))) {
      excluded.push({ path: file, reason: 'credential-like-file' });
      continue;
    }
    if (
      [...excludedArtifactHashes].some((hash) =>
        relativePath.includes(hash),
      )
    ) {
      excluded.push({ path: file, reason: 'protected-artifact' });
      continue;
    }
    included.push(file);
  }

  return {
    included: Object.freeze(included.sort()),
    excluded: Object.freeze(
      excluded.sort((left, right) => left.path.localeCompare(right.path)),
    ),
  };
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function normalizeFragment(fragment: string): string {
  const normalized = normalizeRelativePath(fragment);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}
