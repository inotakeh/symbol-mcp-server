/**
 * Routing in the descriptions of the tools models tend to mix up: the first sentence says which
 * question the tool answers, the second names the tool for each neighbouring question, and
 * symbol_harvesting_income keeps the wording that stopped models from answering harvest income
 * questions with symbol_transaction_search or a browser. Sentences are split as the .mcpb manifest
 * splits them (scripts/mcpb-manifest.mjs), whose tool list shows the first sentence.
 */
import { describe, expect, it } from 'vitest';
import { firstSentence } from '../../scripts/mcpb-manifest.mjs';
import { TOOLS } from '../../src/server.js';

/**
 * Tools answering neighbouring questions, by group, each with the tools its second sentence
 * names (DESIGN-BRIEF §5, common conventions).
 */
const GROUPS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  node: {
    symbol_node_status: ['symbol_node_health', 'symbol_version_drift', 'symbol_network_compare'],
    symbol_node_health: ['symbol_node_status', 'symbol_version_drift', 'symbol_network_compare'],
    symbol_version_drift: ['symbol_node_status', 'symbol_node_health', 'symbol_network_compare'],
    symbol_network_compare: ['symbol_node_status', 'symbol_node_health', 'symbol_version_drift'],
  },
  transaction: {
    symbol_transaction_get: ['symbol_transaction_status'],
    symbol_transaction_status: ['symbol_transaction_get'],
  },
  harvesting: {
    symbol_harvesting_status: [
      'symbol_delegation_diagnose',
      'symbol_harvester_watch',
      'symbol_harvesting_income',
    ],
    symbol_harvester_watch: ['symbol_harvesting_status', 'symbol_delegation_diagnose'],
    symbol_delegation_diagnose: [
      'symbol_harvesting_status',
      'symbol_harvester_watch',
      'symbol_harvesting_income',
    ],
    symbol_harvesting_income: ['symbol_transaction_search', 'symbol_delegation_diagnose'],
    symbol_account_get: ['symbol_delegation_diagnose', 'symbol_harvesting_income'],
  },
};

/** The first two sentences of a tool's description. */
function sentences(name: string): [string, string] {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  const text = tool.description.replace(/\s+/g, ' ').trim();
  const first = firstSentence(text);
  return [first, firstSentence(text.slice(first.length))];
}

describe('tool descriptions route neighbouring questions', () => {
  for (const [group, tools] of Object.entries(GROUPS)) {
    for (const [name, neighbours] of Object.entries(tools)) {
      it(`${name}: first sentence is its own question, second names ${neighbours.join(', ')}`, () => {
        const [first, second] = sentences(name);
        expect(first.match(/symbol_[a-z_]+/g) ?? []).toEqual([]);
        for (const other of neighbours) expect(second, other).toContain(other);
      });
    }

    // The leading verb is only a proxy for "a different question"; the wording is reviewed by hand.
    it(`${group} group: first sentences start with different verbs`, () => {
      const verbs = Object.keys(tools).map((name) => sentences(name)[0].split(' ')[0]);
      expect(new Set(verbs).size, verbs.join(', ')).toBe(verbs.length);
    });
  }

  it('separates the sentences of every description with a space', () => {
    // A lost space merges two sentences, which moves the second sentence's boundary.
    for (const tool of TOOLS) expect(tool.description, tool.name).not.toMatch(/[a-z]\.[A-Z]/);
  });

  it('keeps symbol_harvesting_income the tool for every harvest income question', () => {
    const [first, second] = sentences('symbol_harvesting_income');
    expect(first).toMatch(
      /use this tool whenever the user asks about harvesting rewards, harvest income, or earnings for a period/,
    );
    expect(second).toMatch(/^Do not use symbol_transaction_search or a browser for this/);
    expect(second).toMatch(/harvest rewards are receipts, not transactions/);
  });
});
