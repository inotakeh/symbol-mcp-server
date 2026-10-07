/**
 * MCP prompts: listed in registration order, rendered with the account argument, and free of
 * real-world identifiers. The "no real values" check runs on the templates (before {account} is
 * substituted) and on the rendered text with the passed account removed, so the substituted
 * address itself never trips it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PROMPTS } from '../../src/server.js';
import { uncallableToolNamesIn } from '../removed-tools.js';
import { startTestServer, type TestServer } from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';

const REAL_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[NT][A-Z2-7]{38}\b/, 'base32 address'],
  [/[0-9A-Fa-f]{48,}/, 'hex address, key or hash'],
  [/https?:\/\//, 'URL'],
  [/\b[a-z0-9-]+\.(?:jp|com|net|org|io|dev|tools)\b/, 'host name'],
  [/\b20\d\d-\d\d(?:-\d\d)?\b/, 'calendar date'],
];

/**
 * symbol_network_compare can say on its first line that it could not compare: the prompt must
 * then report the sync as not confirmed, not read the numbers, and send the operator to the
 * reference node settings.
 */
function expectCouldNotCompareHandling(text: string) {
  expect(text).toMatch(/If the first line of its summary says it could not compare/);
  expect(text).toMatch(/not confirmed/);
  expect(text).toMatch(/heightBehindBest/);
  expect(text).toMatch(/SYMBOL_REFERENCE_NODES and that those nodes are reachable/);
}

function realValuesIn(text: string): string[] {
  return REAL_VALUE_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

async function getText(name: string, account: string): Promise<string> {
  if (!server) throw new Error('server not started');
  const result = await server.client.getPrompt({ name, arguments: { account } });
  expect(result.messages).toHaveLength(1);
  const message = result.messages[0];
  if (!message) throw new Error('prompt returned no message');
  expect(message.role).toBe('user');
  expect(message.content.type).toBe('text');
  return (message.content as { text: string }).text;
}

describe('prompts', () => {
  it('lists both prompts in registration order with a required account argument', async () => {
    server = await startTestServer();
    const { prompts } = await server.client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(PROMPTS.map((p) => p.name));
    expect(prompts.map((p) => p.name)).toEqual([
      'voting_key_renewal_checklist',
      'monthly_health_check',
    ]);
    for (const prompt of prompts) {
      expect(prompt.title).toBeTruthy();
      expect(prompt.description).toBeTruthy();
      expect(prompt.arguments?.map((a) => [a.name, a.required])).toEqual([['account', true]]);
      expect(prompt.arguments?.[0]?.description).toMatch(/base32 address/i);
    }
    const again = (await server.client.listPrompts()).prompts.map((p) => p.name);
    expect(again).toEqual(prompts.map((p) => p.name));
  });

  it('renders the renewal checklist with the account and the tools in order', async () => {
    server = await startTestServer();
    const text = await getText('voting_key_renewal_checklist', ADDRESS.toLowerCase());
    expect(text).toContain(`account "${ADDRESS}"`);
    expect(text).not.toContain('{account}');
    const order = [
      'symbol_voting_key_status',
      'symbol_node_status',
      'symbol_network_compare',
      'symbol_transaction_status',
      'symbol_finality_participation',
      'Current key / New key / Expiry / Open items',
    ];
    const positions = order.map((needle) => text.indexOf(needle));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toMatch(/never signs or announces/);
    // The unlink advice is the tool's (its warnings), not a rule of the prompt's own.
    expect(text).toMatch(/every entry of warnings\. Report the warnings as the tool words them/);
    expect(text).toMatch(/Give no advice of your own from slotsFree/);
    expect(text).not.toMatch(/If slotsFree is 0/);
    // After the renewal, what the tool still warns about is reported, not predicted.
    expect(text).toMatch(
      /report every warning the tool still returns, as worded, under Open items/,
    );
    expect(text).not.toMatch(/should be gone|was unlinked so its slot is free/);
    expect(text).toMatch(/not synced, stop/);
    // synced null is "not judged", not "behind": stop too, and say what the tool says.
    expect(text).toMatch(
      /If synced is null, the tool could not judge it: stop here as well, and report the detail of the chain_tip_age check instead of saying that the node is behind/,
    );
    // The same call returns the verdict: it is reported, and adds no stop rule of its own.
    expect(text).toMatch(
      /Report the verdict and every check that is not ok, with its detail as worded, under Open items/,
    );
    expect(text).not.toMatch(/unhealthy, stop|degraded, stop/);
    expect(text).toMatch(/startEpoch has been finalized/);
    expect(text).toMatch(/"participated"/);
    expectCouldNotCompareHandling(text);
  });

  it('renders the monthly health check with last month and the three-level report', async () => {
    server = await startTestServer();
    const text = await getText('monthly_health_check', ADDRESS);
    expect(text).toContain(`account "${ADDRESS}"`);
    const order = [
      'symbol_node_status',
      'symbol_version_drift',
      'symbol_network_compare',
      'symbol_harvesting_status',
      'symbol_voting_key_status',
      'symbol_account_get',
      'symbol_harvesting_income',
    ];
    const positions = order.map((needle) => text.indexOf(needle));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // One call answers health and sync: the verdict, the checks that are not ok, and synced.
    expect(text).toMatch(
      /1\. symbol_node_status: record the verdict, whether synced is true, the node version and the peer count, and every check whose status is warn, fail or unknown, with its detail/,
    );
    expect(text).toMatch(
      /If synced is null, the tool could not judge it: say so instead of calling the node not synced/,
    );
    expect(text).toMatch(/If the verdict is unhealthy, put it at the very top of the report/);
    // Eight numbered steps, and the one that refers to another names the right one.
    const steps = text.match(/^\d+(?=\. )/gm) ?? [];
    expect(steps.map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(text).toMatch(/^5\. symbol_voting_key_status /m);
    expect(text).toMatch(/the eligibility section of the step 5 result/);
    expect(text).toMatch(/behind or far_behind/);
    // One tool lists the unlocked harvesters and compares them; the mode says which.
    expect(text).toMatch(/^4\. symbol_harvesting_status with mode "compare_and_save": /m);
    expect(text).toMatch(
      /The harvesting limits are in the same answer; call the tool again with format "detailed" only if the operator wants the full key list/,
    );
    expect(text).toMatch(/negative deltaCount/);
    expect(text).toMatch(/previous calendar month/);
    expect(text).toMatch(/granularity "daily"/);
    // Receipts are shares: the blocks the account harvested and the blocks of delegators are
    // reported from the block counts, never from the beneficiary receipts.
    expect(text).toMatch(
      /totals\.blocksHarvested as the blocks the node's account harvested itself, and totals\.blocksBeneficiaryOnly as the blocks of delegators or other accounts/,
    );
    expect(text).toMatch(/totals\.receiptsBeneficiary counts receipts, not delegators' blocks/);
    // The voting key warnings are the tool's: no expiry rule of the prompt's own.
    expect(text).toMatch(
      /Put every warning the tool returns at the very top of the report, as worded/,
    );
    expect(text).toMatch(/Add no expiry warning of your own/);
    expect(text).not.toMatch(/If a key expires within 30 days/);
    // Whether a future key is a successor is the tool's call (its warnings), not the prompt's.
    expect(text).not.toMatch(/\(the successor\)/);
    // No arithmetic left to the model: the daily average is gone.
    expect(text).not.toMatch(/average|divided|division/);
    expectCouldNotCompareHandling(text);
    expect(text).toMatch(/Action required \/ Attention \/ Normal/);
  });

  it('requires the account argument and rejects values that are not base32 addresses', async () => {
    server = await startTestServer();
    await expect(
      server.client.getPrompt({ name: 'voting_key_renewal_checklist' }),
    ).rejects.toThrow();
    await expect(
      server.client.getPrompt({ name: 'monthly_health_check', arguments: { account: '' } }),
    ).rejects.toThrow();
    await expect(
      server.client.getPrompt({
        name: 'monthly_health_check',
        arguments: { account: 'CE1992333C60AFEABDB289A14CC1A593FB797339C6D93DEEDB97052AED51845E' },
      }),
    ).rejects.toThrow(/39-character base32 address/);
    await expect(server.client.getPrompt({ name: 'no_such_prompt' })).rejects.toThrow();
  });

  it('names only tools that exist', () => {
    // A prompt that still names a tool after it was removed or merged sends the model nowhere.
    for (const prompt of PROMPTS) {
      expect(prompt.template, prompt.name).toMatch(/symbol_[a-z]+_[a-z_]+/);
      expect(
        uncallableToolNamesIn(`${prompt.template}\n${prompt.description}`),
        prompt.name,
      ).toEqual([]);
    }
  });

  it('contains no real address, host, key, hash or date', async () => {
    for (const prompt of PROMPTS) {
      expect(realValuesIn(prompt.template), prompt.name).toEqual([]);
      expect(realValuesIn(prompt.description), prompt.name).toEqual([]);
    }
    server = await startTestServer();
    for (const prompt of PROMPTS) {
      const rendered = await getText(prompt.name, ADDRESS);
      expect(realValuesIn(rendered.split(ADDRESS).join('')), prompt.name).toEqual([]);
    }
  });
});
