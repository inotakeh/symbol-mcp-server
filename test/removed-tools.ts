/**
 * The tools that a release shipped and a later one removed or merged into another tool, and the
 * check that a text names none of them. A description, the instructions or a prompt that still
 * names such a tool sends the model to a tool that does not exist.
 *
 * This is the one place that lists them: add the name in the pull request that removes the tool,
 * and the tests that use this module cover it (test/unit/removed-tools.test.ts and
 * instructions.test.ts, test/tools/server.test.ts and prompts.test.ts for what the server hands
 * out; test/unit/docs-sync.test.ts for the READMEs, CONTRIBUTING.md and the protected SECURITY.md,
 * server.json and mcpb/manifest.json).
 */
import { TOOLS } from '../src/server.js';

export const REMOVED_TOOLS: readonly string[] = [
  // 0.10.0: merged into symbol_node_status
  'symbol_node_health',
  // 0.10.0: merged into symbol_harvesting_status (its modes compare, compare_and_save, save_only)
  'symbol_harvester_watch',
];

/**
 * The tool names in `text` that no client can call: a removed tool, or any other name of the form
 * `symbol_…` that is not registered (so a mistyped name is found too). Empty when the text names
 * only tools that exist.
 */
export function uncallableToolNamesIn(text: string): string[] {
  const registered = new Set<string>(TOOLS.map((t) => t.name));
  const unregistered = (text.match(/symbol_[a-z_]+/g) ?? []).filter((n) => !registered.has(n));
  const removed = REMOVED_TOOLS.filter((name) => text.includes(name));
  return [...new Set([...removed, ...unregistered])];
}
