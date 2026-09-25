import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicKeyToAddress } from '../../src/domain/address.js';
import { TOOLS } from '../../src/server.js';
import {
  ALIAS_NAMESPACE_ID,
  ALIAS_NAMESPACE_NAME,
  fixture,
  H,
  mainnetRoutes,
  resourceNotFound,
  startTestServer,
  TEST_NODE_HOST,
  type TestServer,
  type ToolCallResult,
  XYM_MOSAIC_ID,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

const TOOL = 'symbol_holdings_value';
const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
const PUBLIC_KEY = 'CE1992333C60AFEABDB289A14CC1A593FB797339C6D93DEEDB97052AED51845E';
const OTHER_MOSAIC_ID = '66BAE04E8758599E';
/** A valid address the fake node knows nothing about. */
const UNKNOWN_ADDRESS = publicKeyToAddress(H('fixture:counterparty-2'), 104);

const FIXED_NOTE_PATTERNS = [/supplied by the caller/, /no exchange fees/, /not a tax computation/];

type Output = {
  summary: string;
  network: string;
  address: string;
  accountResolution: unknown;
  mosaic: { id: string; alias: string | null; divisibility: number };
  balance: { amount: string; raw: string };
  price: { unitPrice: string; currency: string; source: string | null; asOf: string | null };
  value: {
    amount: string;
    exact: string;
    currency: string;
    roundingDecimals: number | null;
    decimalsSource: string;
  };
  notes: string[];
};

/** The second summary line for a currency Intl rounds to its own digits. */
const intlRounded = (decimals: string, currency: string) =>
  `Rounded half up to ${decimals}, as Intl (Unicode CLDR) formats ${currency}.`;

const outputSchema = TOOLS.find((t) => t.name === TOOL)?.outputSchema;

function checkShape(result: ToolCallResult): Output {
  expect(result.isError).toBe(false);
  const sc = result.structuredContent as Output;
  expect(outputSchema?.safeParse(sc).success).toBe(true);
  expect(Object.keys(sc)[0]).toBe('summary');
  expect(result.text).toBe(JSON.stringify(sc, null, 2));
  return sc;
}

function expectOnlyTestNode(s: TestServer) {
  expect(new Set(s.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
}

describe('symbol_holdings_value', () => {
  it('values 4,321,000 XYM at 12.34 JPY with the provenance echoed', async () => {
    server = await startTestServer();
    const sc = checkShape(
      await server.callTool(TOOL, {
        account: ADDRESS,
        unitPrice: '12.34',
        currency: 'JPY',
        priceSource: 'Zaif XYM/JPY last',
        priceAsOf: '2026-09-22T21:00:00+09:00',
      }),
    );
    expect(sc.network).toBe('mainnet');
    expect(sc.address).toBe(ADDRESS);
    expect(sc.accountResolution).toBeNull();
    expect(sc.mosaic).toEqual({ id: XYM_MOSAIC_ID, alias: 'symbol.xym', divisibility: 6 });
    expect(sc.balance).toEqual({ amount: '4321000.000000', raw: '4321000000000' });
    expect(sc.price).toEqual({
      unitPrice: '12.34',
      currency: 'JPY',
      source: 'Zaif XYM/JPY last',
      asOf: '2026-09-22T21:00:00+09:00',
    });
    expect(sc.value).toEqual({
      amount: '53321140',
      exact: '53321140.00000000',
      currency: 'JPY',
      roundingDecimals: 0,
      decimalsSource: 'currency',
    });
    expect(sc.summary).toBe(
      [
        `${ADDRESS} holds 4,321,000.000000 symbol.xym; at 12.34 JPY per XYM that is 53,321,140 JPY (price supplied by the caller: Zaif XYM/JPY last, as of 2026-09-22T21:00:00+09:00).`,
        intlRounded('whole units', 'JPY'),
      ].join('\n'),
    );
    for (const pattern of FIXED_NOTE_PATTERNS) {
      expect(
        sc.notes.some((n) => pattern.test(n)),
        String(pattern),
      ).toBe(true);
    }
    // Only the account is read; no holder list, no extra mosaic lookups for the currency.
    expect(server.requests.some((u) => u.pathname === `/accounts/${ADDRESS}`)).toBe(true);
    expect(server.requests.some((u) => u.pathname === '/accounts')).toBe(false);
    expectOnlyTestNode(server);
  });

  it('rounds to the digits Intl gives USD, KRW and KWD, and leaves out missing provenance', async () => {
    server = await startTestServer();
    const usd = checkShape(
      await server.callTool(TOOL, { account: ADDRESS, unitPrice: '0.0312', currency: 'USD' }),
    );
    expect(usd.price).toEqual({ unitPrice: '0.0312', currency: 'USD', source: null, asOf: null });
    expect(usd.value).toEqual({
      amount: '134815.20',
      exact: '134815.2000000000',
      currency: 'USD',
      roundingDecimals: 2,
      decimalsSource: 'currency',
    });
    expect(usd.summary).toBe(
      [
        `${ADDRESS} holds 4,321,000.000000 symbol.xym; at 0.0312 USD per XYM that is 134,815.20 USD (price supplied by the caller).`,
        intlRounded('2 decimals', 'USD'),
      ].join('\n'),
    );

    const krw = checkShape(
      await server.callTool(TOOL, { account: ADDRESS, unitPrice: '41.5', currency: 'KRW' }),
    );
    expect(krw.value).toMatchObject({ amount: '179321500', roundingDecimals: 0 });

    // Three decimals, which a fixed 2 would have cut: 5,185.2 KWD.
    const kwd = checkShape(
      await server.callTool(TOOL, { account: ADDRESS, unitPrice: '0.0012', currency: 'KWD' }),
    );
    expect(kwd.value).toMatchObject({
      amount: '5185.200',
      roundingDecimals: 3,
      decimalsSource: 'currency',
    });
    expect(kwd.summary.split('\n')[1]).toBe(intlRounded('3 decimals', 'KWD'));
  });

  it('shows the unrounded value on a third line when detailed', async () => {
    server = await startTestServer();
    const args = { account: ADDRESS, unitPrice: '0.0312', currency: 'USD' };
    const concise = checkShape(await server.callTool(TOOL, args));
    const detailed = checkShape(await server.callTool(TOOL, { ...args, format: 'detailed' }));
    const lines = detailed.summary.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2).join('\n')).toBe(concise.summary);
    expect(lines[2]).toBe('Unrounded: 134,815.2000000000 USD.');
    expect({ ...detailed, summary: '' }).toEqual({ ...concise, summary: '' });
  });

  it('does not round a code Intl does not know, such as BTC', async () => {
    server = await startTestServer();
    const concise = checkShape(
      await server.callTool(TOOL, { account: ADDRESS, unitPrice: '0.0000123', currency: 'BTC' }),
    );
    expect(concise.value).toEqual({
      amount: '53.1483',
      exact: '53.1483000000000',
      currency: 'BTC',
      roundingDecimals: null,
      decimalsSource: 'none',
    });
    expect(concise.summary.split('\n')).toEqual([
      `${ADDRESS} holds 4,321,000.000000 symbol.xym; at 0.0000123 BTC per XYM that is 53.1483 BTC (price supplied by the caller).`,
      'Not rounded: Intl (Unicode CLDR) does not know BTC, so this is the exact product.',
    ]);
    // Nothing was rounded, so detailed adds no "Unrounded" line.
    const detailed = checkShape(
      await server.callTool(TOOL, {
        account: ADDRESS,
        unitPrice: '0.0000123',
        currency: 'BTC',
        format: 'detailed',
      }),
    );
    expect(detailed.summary).toBe(concise.summary);
  });

  it('keeps a small XAU value from showing as 0.00 and says so', async () => {
    server = await startTestServer();
    // Intl knows gold (XAU) and gives it the CLDR default of 2 digits: 43.21 XAU is rounded.
    const large = checkShape(
      await server.callTool(TOOL, { account: ADDRESS, unitPrice: '0.00001', currency: 'XAU' }),
    );
    expect(large.value).toMatchObject({
      amount: '43.21',
      roundingDecimals: 2,
      decimalsSource: 'currency',
    });
    // 0.004321 XAU would be 0.00 at 2 digits: the exact value is kept.
    const small = checkShape(
      await server.callTool(TOOL, { account: ADDRESS, unitPrice: '0.000000001', currency: 'XAU' }),
    );
    expect(small.value).toEqual({
      amount: '0.004321',
      exact: '0.004321000000000',
      currency: 'XAU',
      roundingDecimals: null,
      decimalsSource: 'rounds_to_zero',
    });
    expect(small.summary.split('\n')).toEqual([
      `${ADDRESS} holds 4,321,000.000000 symbol.xym; at 0.000000001 XAU per XYM that is 0.004321 XAU (price supplied by the caller).`,
      'Not rounded: rounding to 2 decimals as Intl (Unicode CLDR) formats XAU would show it as 0, so this is the exact product.',
    ]);
  });

  it('rounds to the decimals the caller asks for, with the same safety net', async () => {
    server = await startTestServer();
    const usd = checkShape(
      await server.callTool(TOOL, {
        account: ADDRESS,
        unitPrice: '0.0312',
        currency: 'USD',
        decimals: 4,
      }),
    );
    expect(usd.value).toMatchObject({
      amount: '134815.2000',
      roundingDecimals: 4,
      decimalsSource: 'caller',
    });
    expect(usd.summary.split('\n')[1]).toBe('Rounded half up to 4 decimals, as requested.');

    const btc = checkShape(
      await server.callTool(TOOL, {
        account: ADDRESS,
        unitPrice: '0.0000123',
        currency: 'BTC',
        decimals: 2,
      }),
    );
    expect(btc.value).toMatchObject({
      amount: '53.15',
      roundingDecimals: 2,
      decimalsSource: 'caller',
    });

    // 0.4321 USD at whole units would be 0: kept exact even though the caller asked for 0.
    const tiny = checkShape(
      await server.callTool(TOOL, {
        account: ADDRESS,
        unitPrice: '0.0000001',
        currency: 'USD',
        decimals: 0,
      }),
    );
    expect(tiny.value).toMatchObject({
      amount: '0.4321',
      roundingDecimals: null,
      decimalsSource: 'rounds_to_zero',
    });
    expect(tiny.summary.split('\n')[1]).toBe(
      'Not rounded: rounding to whole units as requested would show it as 0, so this is the exact product.',
    );
  });

  it.each([-1, 13, 1.5])(
    'rejects decimals %j with a hint before contacting the node',
    async (decimals) => {
      server = await startTestServer();
      const before = server.requests.length;
      const result = await server.callTool(TOOL, {
        account: ADDRESS,
        unitPrice: '1',
        currency: 'JPY',
        decimals,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/integer from 0 to 12/);
      expect(server.requests.length).toBe(before);
    },
  );

  it('normalises the unit price (leading and trailing zeros) and accepts a public key', async () => {
    server = await startTestServer();
    const sc = checkShape(
      await server.callTool(TOOL, { account: PUBLIC_KEY, unitPrice: '012.340', currency: 'JPY' }),
    );
    expect(sc.address).toBe(ADDRESS);
    expect(sc.price.unitPrice).toBe('12.34');
    expect(sc.value).toMatchObject({ amount: '53321140', exact: '53321140.00000000' });
    expect(sc.summary).toMatch(/at 12\.34 JPY per XYM/);
    // The public key never appears in the output.
    expect(JSON.stringify(sc)).not.toContain(PUBLIC_KEY);
  });

  it('values another mosaic given as a hex id (divisibility 0) with its own unit label', async () => {
    const acct = fixture<{ account: { mosaics: unknown[] } }>('mainnet/account-voting.json');
    acct.account.mosaics = [
      { id: XYM_MOSAIC_ID, amount: '4321000000000' },
      { id: OTHER_MOSAIC_ID, amount: '1500' },
    ];
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${ADDRESS}`]: acct },
    });
    const sc = checkShape(
      await server.callTool(TOOL, {
        account: ADDRESS,
        mosaic: OTHER_MOSAIC_ID,
        unitPrice: '2.5',
        currency: 'JPY',
      }),
    );
    expect(sc.mosaic).toEqual({ id: OTHER_MOSAIC_ID, alias: null, divisibility: 0 });
    expect(sc.balance).toEqual({ amount: '1500', raw: '1500' });
    expect(sc.value).toEqual({
      amount: '3750',
      exact: '3750.0',
      currency: 'JPY',
      roundingDecimals: 0,
      decimalsSource: 'currency',
    });
    expect(sc.summary).toBe(
      [
        `${ADDRESS} holds 1,500 ${OTHER_MOSAIC_ID}; at 2.5 JPY per ${OTHER_MOSAIC_ID} that is 3,750 JPY (price supplied by the caller).`,
        intlRounded('whole units', 'JPY'),
      ].join('\n'),
    );
    expect(server.requests.some((u) => u.pathname === `/mosaics/${OTHER_MOSAIC_ID}`)).toBe(true);
    expectOnlyTestNode(server);
  });

  it('accepts the mosaic as an alias name and reports a zero balance', async () => {
    const acct = fixture<{ account: { mosaics: unknown[] } }>('mainnet/account-voting.json');
    acct.account.mosaics = [{ id: OTHER_MOSAIC_ID, amount: '7' }];
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${ADDRESS}`]: acct },
    });
    const sc = checkShape(
      await server.callTool(TOOL, {
        account: ADDRESS,
        mosaic: 'symbol.xym',
        unitPrice: '12.34',
        currency: 'JPY',
      }),
    );
    expect(sc.mosaic).toEqual({ id: XYM_MOSAIC_ID, alias: 'symbol.xym', divisibility: 6 });
    expect(sc.balance).toEqual({ amount: '0.000000', raw: '0' });
    // A zero balance is 0 at the currency's digits, not an "unrounded" value.
    expect(sc.value).toEqual({
      amount: '0',
      exact: '0.00000000',
      currency: 'JPY',
      roundingDecimals: 0,
      decimalsSource: 'currency',
    });
    expect(sc.summary).toMatch(/holds 0\.000000 symbol\.xym; at 12\.34 JPY per XYM that is 0 JPY/);
    expect(server.requests.some((u) => u.pathname === '/namespaces/E74B99BA41F4AFEE')).toBe(true);
    expectOnlyTestNode(server);
  });

  it('resolves a namespace name to the account and prefixes the summary', async () => {
    server = await startTestServer();
    const sc = checkShape(
      await server.callTool(TOOL, {
        account: ALIAS_NAMESPACE_NAME,
        unitPrice: '12.34',
        currency: 'JPY',
      }),
    );
    expect(sc.address).toBe(ADDRESS);
    expect(sc.accountResolution).toEqual({
      input: ALIAS_NAMESPACE_NAME,
      namespace: ALIAS_NAMESPACE_NAME,
      namespaceId: ALIAS_NAMESPACE_ID,
      address: ADDRESS,
    });
    expect(sc.summary.startsWith(`${ALIAS_NAMESPACE_NAME} → ${ADDRESS}. ${ADDRESS} holds`)).toBe(
      true,
    );
    expect(sc.value.amount).toBe('53321140');
    expectOnlyTestNode(server);
  });

  it.each([
    ['1e3', /exponent/],
    ['1,200', /thousands separators/],
    ['¥12', /currency symbol/],
    ['-1', /no sign/],
    ['', /empty|plain positive decimal/],
    ['12.', /plain positive decimal/],
    ['.5', /plain positive decimal/],
    ['0', /positive price/],
    [`0.${'0'.repeat(12)}1`, /at most 12/],
  ])('rejects unitPrice %j with a hint before contacting the node', async (unitPrice, hint) => {
    server = await startTestServer();
    const before = server.requests.length;
    const result = await server.callTool(TOOL, { account: ADDRESS, unitPrice, currency: 'JPY' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(hint);
    expect(result.structuredContent).toBeUndefined();
    expect(server.requests.length).toBe(before);
  });

  it.each(['jpy', 'JP', 'ABCDEFG', 'JP1', '¥'])(
    'rejects currency %j with a hint before contacting the node',
    async (currency) => {
      server = await startTestServer();
      const before = server.requests.length;
      const result = await server.callTool(TOOL, { account: ADDRESS, unitPrice: '1', currency });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/3 to 6 upper-case letters/);
      expect(server.requests.length).toBe(before);
    },
  );

  it('rejects a priceAsOf that is not a date, and a numeric unitPrice', async () => {
    server = await startTestServer();
    const before = server.requests.length;
    const asOf = await server.callTool(TOOL, {
      account: ADDRESS,
      unitPrice: '1',
      currency: 'JPY',
      priceAsOf: 'yesterday evening',
    });
    expect(asOf.isError).toBe(true);
    expect(asOf.text).toMatch(/priceAsOf/);
    expect(asOf.text).toMatch(/ISO 8601/);
    expect(server.requests.length).toBe(before);

    // A JSON number is refused by the input schema: the price must be a string.
    const numeric = await server.callTool(TOOL, {
      account: ADDRESS,
      unitPrice: 12.34,
      currency: 'JPY',
    });
    expect(numeric.isError).toBe(true);
    expect(server.requests.length).toBe(before);
  });

  it('strips control and bidi characters from priceSource and priceAsOf', async () => {
    server = await startTestServer();
    const sc = checkShape(
      await server.callTool(TOOL, {
        account: ADDRESS,
        unitPrice: '1',
        currency: 'JPY',
        priceSource: 'Zaif\u0000 XYM/JPY\u202E last\u001B[31m',
        priceAsOf: '2026-09-22T21:00:00+09:00\u200B',
      }),
    );
    expect(sc.price.source).toBe('Zaif XYM/JPY last[31m');
    expect(sc.price.asOf).toBe('2026-09-22T21:00:00+09:00');
    // No control, zero-width or bidi code point anywhere in the serialised result.
    const codePoints = Array.from(JSON.stringify(sc), (ch) => ch.codePointAt(0) ?? 0);
    const forbidden = codePoints.filter(
      (cp) =>
        cp < 0x20 ||
        (cp >= 0x7f && cp <= 0x9f) ||
        (cp >= 0x200b && cp <= 0x200f) ||
        (cp >= 0x202a && cp <= 0x202e),
    );
    expect(forbidden).toEqual([]);
  });

  it('rejects a priceSource longer than 80 characters', async () => {
    server = await startTestServer();
    const result = await server.callTool(TOOL, {
      account: ADDRESS,
      unitPrice: '1',
      currency: 'JPY',
      priceSource: 'x'.repeat(81),
    });
    expect(result.isError).toBe(true);
  });

  it('gives a hinted error for an unknown account and for a bad identifier', async () => {
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        [`GET /accounts/${UNKNOWN_ADDRESS}`]: resourceNotFound(UNKNOWN_ADDRESS),
      },
    });
    const unknown = await server.callTool(TOOL, {
      account: UNKNOWN_ADDRESS,
      unitPrice: '1',
      currency: 'JPY',
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/No account with address/);

    const bad = await server.callTool(TOOL, {
      account: 'not an account',
      unitPrice: '1',
      currency: 'JPY',
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not a valid Symbol account identifier/);
  });

  it('never contacts anything but SYMBOL_NODE_URL, even with reference nodes configured', async () => {
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: 'https://ref-a.test:3001,https://ref-b.test:3001' },
    });
    checkShape(
      await server.callTool(TOOL, {
        account: ALIAS_NAMESPACE_NAME,
        mosaic: 'symbol.xym',
        unitPrice: '12.34',
        currency: 'JPY',
        priceSource: 'https://api.example.com/ticker',
      }),
    );
    // No price API, no reference node: the fake fetch saw the configured node only.
    expectOnlyTestNode(server);
    const paths = new Set(server.requests.map((u) => u.pathname));
    for (const p of paths) {
      expect(p).toMatch(/^\/(node|chain|network|accounts|mosaics|namespaces)(\/|$)/);
    }
  });
});
