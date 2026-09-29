/** Types for scripts/release-definitions.mjs, so the TypeScript tests can import it. */

export declare const DEFINITIONS_SNAPSHOT: string;

export declare const MAX_LISTED_CHANGES: number;

export interface SplitDefinitions {
  tools: Map<unknown, Record<string, unknown>>;
  toolOrder: unknown[];
  prompts: Map<unknown, Record<string, unknown>>;
  promptOrder: unknown[];
  argumentOrders: Map<unknown, unknown[]>;
  rest: Record<string, unknown>;
  texts: Map<string, string>;
}

export declare function splitDefinitions(definitions: Record<string, unknown>): SplitDefinitions;

export interface DefinitionsComparison {
  shapeChanges: string[];
  textChanges: string[];
  textOwners: string[];
}

export declare function compareDefinitions(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): DefinitionsComparison;

export declare function definitionsCheck(
  version: string,
  input: {
    previousVersion: string;
    previousLabel: string;
    previous: unknown;
    current: unknown;
    changelog: string;
    diffCommand: string;
  },
): { verdict: string; problems: string[] };

export type SnapshotRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'ref' | 'path' | 'git' | 'json'; detail: string };

export declare function readSnapshotAt(ref: string, path: string, cwd: string): SnapshotRead;

export declare const PREVIOUS_FLAG: string;

export declare function unreadableDefinitions(
  previousVersion: string,
  ref: string,
  failure: { reason: string; detail: string },
  options: { inWorkflow: boolean },
): string;
