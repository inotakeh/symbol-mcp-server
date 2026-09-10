import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { RestClient, RestError } from '../../src/client/rest.js';
import { jsonResponse } from '../tools/harness.js';

const Schema = z.object({ ok: z.boolean() });

function client(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof RestClient>[0]> = {},
) {
  return new RestClient({
    baseUrl: 'https://node.test:3001/',
    timeoutMs: 500,
    userAgent: 'symbol-mcp-server/test',
    fetchImpl,
    ...extra,
  });
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    return err instanceof RestError ? err.kind : `other:${String(err)}`;
  }
}

describe('RestClient', () => {
  it('normalises the base URL and sends the hygiene headers', async () => {
    let seen: Request | undefined;
    const c = client((async (input, init) => {
      seen = new Request(input, init);
      return jsonResponse({ ok: true });
    }) as typeof fetch);
    expect(c.baseUrl).toBe('https://node.test:3001');
    expect(c.host).toBe('node.test:3001');
    await expect(c.get('/chain/info', Schema)).resolves.toEqual({ ok: true });
    expect(seen?.url).toBe('https://node.test:3001/chain/info');
    expect(seen?.headers.get('user-agent')).toBe('symbol-mcp-server/test');
    expect(seen?.headers.get('accept')).toBe('application/json');
  });

  it('sends JSON bodies for POST', async () => {
    let body = '';
    const c = client((async (input, init) => {
      const req = new Request(input, init);
      body = await req.text();
      expect(req.method).toBe('POST');
      expect(req.headers.get('content-type')).toBe('application/json');
      return jsonResponse({ ok: true });
    }) as typeof fetch);
    await c.post('/namespaces/mosaic/names', { mosaicIds: ['A'] }, Schema);
    expect(JSON.parse(body)).toEqual({ mosaicIds: ['A'] });
  });

  it('maps status codes and failures to RestError kinds', async () => {
    expect(
      await kindOf(client((async () => jsonResponse({}, 404)) as typeof fetch).get('/x', Schema)),
    ).toBe('not_found');
    expect(
      await kindOf(client((async () => jsonResponse({}, 500)) as typeof fetch).get('/x', Schema)),
    ).toBe('http');
    expect(
      await kindOf(
        client((async () => new Response('<html>', { status: 200 })) as typeof fetch).get(
          '/x',
          Schema,
        ),
      ),
    ).toBe('invalid_response');
    expect(
      await kindOf(
        client((async () => jsonResponse({ ok: 'yes' })) as typeof fetch).get('/x', Schema),
      ),
    ).toBe('invalid_response');
    expect(
      await kindOf(
        client((async () => {
          throw new TypeError('fetch failed');
        }) as typeof fetch).get('/x', Schema),
      ),
    ).toBe('unreachable');
    const timeoutErr = new Error('timed out');
    timeoutErr.name = 'TimeoutError';
    expect(
      await kindOf(
        client((async () => {
          throw timeoutErr;
        }) as typeof fetch).get('/x', Schema),
      ),
    ).toBe('timeout');
  });

  it('getOrNull maps 404 to null but rethrows other errors', async () => {
    await expect(
      client((async () => jsonResponse({}, 404)) as typeof fetch).getOrNull('/x', Schema),
    ).resolves.toBeNull();
    await expect(
      client((async () => jsonResponse({}, 503)) as typeof fetch).getOrNull('/x', Schema),
    ).rejects.toThrow(RestError);
  });

  it('rejects oversized responses by content-length and by stream size', async () => {
    const declared = client(
      (async () =>
        jsonResponse({ ok: true }, 200, { 'content-length': '999999999' })) as typeof fetch,
      { maxBodyBytes: 1024 },
    );
    expect(await kindOf(declared.get('/x', Schema))).toBe('too_large');

    const big = `{"ok":true,"pad":"${'x'.repeat(5000)}"}`;
    const streamed = client((async () => new Response(big, { status: 200 })) as typeof fetch, {
      maxBodyBytes: 1024,
    });
    expect(await kindOf(streamed.get('/x', Schema))).toBe('too_large');
  });

  it('never keeps more than maxConcurrency requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const c = client(
      (async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return jsonResponse({ ok: true });
      }) as typeof fetch,
      { maxConcurrency: 2 },
    );
    await Promise.all(Array.from({ length: 8 }, (_, i) => c.get(`/x/${i}`, Schema)));
    expect(peak).toBe(2);
  });

  it('error messages never include response bodies', async () => {
    const c = client(
      (async () => new Response('SECRET-BODY-CONTENT', { status: 500 })) as typeof fetch,
    );
    await expect(c.get('/x', Schema)).rejects.toThrow(/HTTP 500/);
    await expect(c.get('/x', Schema)).rejects.not.toThrow(/SECRET-BODY/);
  });
});
