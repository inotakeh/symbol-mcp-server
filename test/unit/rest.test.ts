import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { RestClient, RestError } from '../../src/client/rest.js';
import { jsonResponse } from '../tools/harness.js';

const Schema = z.object({ ok: z.boolean() });

/**
 * A response body that records what was pulled from it and whether it was cancelled. `lazy`
 * (high-water mark 0) pulls nothing until someone reads, so "never read" is observable.
 */
function trackedBody(chunkBytes = 1024, lazy = false) {
  const state = { pulls: 0, pulledBytes: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(0x20);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls++;
        state.pulledBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: lazy ? 0 : 1 },
  );
  return { stream, state };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

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
    expect(seen?.redirect).toBe('manual');
  });

  it('reports a 3xx answer as a redirect, discards its body and never quotes the Location', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { stream, state } = trackedBody(1024, true);
      const c = client(
        (async () =>
          new Response(stream, {
            status,
            headers: { location: 'https://elsewhere.example/node/info' },
          })) as typeof fetch,
      );
      const err = await c.get('/node/info', Schema).catch((e: unknown) => e);
      expect(err, `HTTP ${status}`).toBeInstanceOf(RestError);
      expect(err).toMatchObject({ kind: 'redirect', status, path: '/node/info' });
      expect((err as Error).message).toBe(
        `node.test:3001 answered /node/info with a redirect (HTTP ${status}), which is not followed`,
      );
      expect(state.cancelled, `HTTP ${status}`).toBe(true);
      expect(state.pulls, `HTTP ${status}`).toBe(0);
    }
  });

  it('keeps another 3xx (300, 304) an HTTP error, not a redirect, and discards its body', async () => {
    const { stream, state } = trackedBody(1024, true);
    const multiple = await client(
      (async () => new Response(stream, { status: 300 })) as typeof fetch,
    )
      .get('/x', Schema)
      .catch((e: unknown) => e);
    expect(multiple).toMatchObject({ kind: 'http', status: 300 });
    expect(state.cancelled).toBe(true);
    const notModified = await client(
      (async () => new Response(null, { status: 304 })) as typeof fetch,
    )
      .get('/x', Schema)
      .catch((e: unknown) => e);
    expect(notModified).toMatchObject({ kind: 'http', status: 304 });
  });

  it('treats an opaque-redirect response, as a spec-conforming fetch returns it, as a redirect', async () => {
    // The constructor refuses status 0, so the two fields of a real opaque redirect are set here.
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, 'type', { value: 'opaqueredirect' });
    Object.defineProperty(opaque, 'status', { value: 0 });
    const err = await client((async () => opaque) as typeof fetch)
      .get('/node/info', Schema)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'redirect', status: undefined });
    expect((err as Error).message).toMatch(/\(HTTP 3xx\)/);
  });

  it('never follows a real redirect: the target of the Location is not contacted', async () => {
    let targetHits = 0;
    const target = createServer((_request, response) => {
      targetHits++;
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    await listen(target);
    const origin = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${portOf(target)}/node/info` });
      response.end('moved');
    });
    await listen(origin);
    try {
      // The real global fetch, not a stub.
      const c = new RestClient({
        baseUrl: `http://127.0.0.1:${portOf(origin)}`,
        timeoutMs: 5_000,
        userAgent: 'symbol-mcp-server/test',
      });
      const err = await c.get('/node/info', Schema).catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'redirect', status: 302 });
      expect((err as Error).message).not.toContain(`127.0.0.1:${portOf(target)}`);
      expect(targetHits).toBe(0);
    } finally {
      await Promise.all([close(origin), close(target)]);
    }
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

  it('parses the body of an accepted non-2xx status, and only that status', async () => {
    // /node/health answers 503 with the same DTO when a service is down.
    await expect(
      client((async () => jsonResponse({ ok: false }, 503)) as typeof fetch).get('/x', Schema, {
        acceptStatuses: [503],
      }),
    ).resolves.toEqual({ ok: false });
    expect(
      await kindOf(
        client((async () => jsonResponse({ ok: false }, 503)) as typeof fetch).get('/x', Schema),
      ),
    ).toBe('http');
    expect(
      await kindOf(
        client((async () => jsonResponse({ ok: false }, 500)) as typeof fetch).get('/x', Schema, {
          acceptStatuses: [503],
        }),
      ),
    ).toBe('http');
    expect(
      await kindOf(
        client((async () => new Response('<html>', { status: 503 })) as typeof fetch).get(
          '/x',
          Schema,
          { acceptStatuses: [503] },
        ),
      ),
    ).toBe('invalid_response');
    expect(
      await kindOf(
        client((async () => jsonResponse({}, 404)) as typeof fetch).get('/x', Schema, {
          acceptStatuses: [503],
        }),
      ),
    ).toBe('not_found');
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

  it('stops reading a body that grows past the limit and cancels the rest', async () => {
    const CHUNK = 64 * 1024;
    const LIMIT = 4 * CHUNK;
    // An endless body: without the limit the read would never finish.
    const { stream, state } = trackedBody(CHUNK);
    const c = client((async () => new Response(stream, { status: 200 })) as typeof fetch, {
      maxBodyBytes: LIMIT,
    });
    expect(await kindOf(c.get('/x', Schema))).toBe('too_large');
    expect(state.cancelled).toBe(true);
    // The chunk that crossed the limit, plus at most one the stream had queued ahead.
    expect(state.pulledBytes).toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
  });

  it('still reports too_large when cancelling the oversized body fails', async () => {
    const chunk = new Uint8Array(2048).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        throw new Error('the stream cannot be cancelled');
      },
    });
    const c = client((async () => new Response(stream, { status: 200 })) as typeof fetch, {
      maxBodyBytes: 1024,
    });
    expect(await kindOf(c.get('/x', Schema))).toBe('too_large');
  });

  it('discards the body of an answer it does not read, without reading any of it', async () => {
    const answers: ReadonlyArray<readonly [number, Record<string, string>]> = [
      [404, {}],
      [500, {}],
      [200, { 'content-length': '999999999' }],
    ];
    for (const [status, headers] of answers) {
      const { stream, state } = trackedBody(1024, true);
      const c = client((async () => new Response(stream, { status, headers })) as typeof fetch, {
        maxBodyBytes: 1024,
      });
      await c.get('/x', Schema).catch(() => undefined);
      expect(state.cancelled, `HTTP ${status}`).toBe(true);
      expect(state.pulls, `HTTP ${status}`).toBe(0);
    }
  });

  it('refuses a path that is not plain segments and query values, before any request', async () => {
    let calls = 0;
    const c = client((async () => {
      calls++;
      return jsonResponse({ ok: true });
    }) as typeof fetch);
    for (const path of [
      '/accounts/../node/info',
      '/a?b=c#d',
      '/a b',
      '/a%2e%2e',
      '//elsewhere.example/x',
      '/a\\b',
      'accounts',
      '/accounts?x=1&y=a.b',
      '/accounts?x',
      '/',
    ]) {
      await expect(c.get(path, Schema), path).rejects.toThrow(/refusing to request/);
    }
    expect(calls).toBe(0);
    for (const path of [
      '/node/info',
      '/transactions/confirmed/0A1B',
      '/accounts?mosaicId=6BED913FA20223F8&orderBy=balance&order=desc&pageSize=100&pageNumber=1',
    ]) {
      await expect(c.get(path, Schema), path).resolves.toEqual({ ok: true });
    }
    expect(calls).toBe(3);
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
