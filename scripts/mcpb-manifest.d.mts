/** Types for scripts/mcpb-manifest.mjs, so the TypeScript tests can import it. */

export declare const PROMPT_ACCOUNT_TOKEN: string;
export declare const MANIFEST_ACCOUNT_TOKEN: string;

export declare function firstSentence(text: string): string;

export interface ManifestTool {
  name: string;
  description: string;
}

export interface ManifestPrompt {
  name: string;
  description: string;
  arguments: string[];
  text: string;
}

export declare function buildManifest(
  template: Record<string, unknown>,
  parts: {
    version: string;
    tools: ReadonlyArray<{ readonly name: string; readonly description: string }>;
    prompts: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly template: string;
    }>;
  },
): Record<string, unknown> & { version: string; tools: ManifestTool[]; prompts: ManifestPrompt[] };
