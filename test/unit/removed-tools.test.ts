import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/server.js';
import { REMOVED_TOOLS, uncallableToolNamesIn } from '../removed-tools.js';

describe('removed tools', () => {
  it('are not registered: the name of a removed tool is never used again', () => {
    // A client that kept an older tools/list, or a model that remembers the old tool, would call
    // the name with its old meaning.
    const registered = new Set<string>(TOOLS.map((t) => t.name));
    expect(REMOVED_TOOLS.filter((name) => registered.has(name))).toEqual([]);
    for (const name of REMOVED_TOOLS) expect(name).toMatch(/^symbol_[a-z]+_[a-z_]+$/);
  });
});

describe('the check for tool names that cannot be called', () => {
  it('finds each removed tool', () => {
    for (const removed of REMOVED_TOOLS) {
      expect(uncallableToolNamesIn(`For whether it is healthy, use ${removed}.`)).toEqual([
        removed,
      ]);
    }
  });

  it('finds a name that was never registered, once, and accepts the tools that exist', () => {
    expect(
      uncallableToolNamesIn('symbol_no_such_tool; symbol_node_status. Not symbol_no_such_tool!'),
    ).toEqual(['symbol_no_such_tool']);
    expect(uncallableToolNamesIn(TOOLS.map((t) => `use ${t.name}.`).join(' '))).toEqual([]);
    // The prompts say "the symbol_* tools": no name, nothing to find.
    expect(uncallableToolNamesIn('Use only the symbol_* tools of symbol-mcp-server.')).toEqual([]);
  });
});
