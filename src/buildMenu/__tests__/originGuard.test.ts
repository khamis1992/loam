import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { configureBuildMenu, handleBuildMenuRoutes } from '../../server/routes/buildMenu.js';

function fakeReq(headers: http.IncomingHttpHeaders): http.IncomingMessage {
  const req = Readable.from([]) as http.IncomingMessage;
  req.method = 'POST';
  req.headers = headers;
  return req;
}

function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(code: number) { this.status = code; },
    end(text: string) { this.body = text; },
  };
}

async function status(headers: http.IncomingHttpHeaders): Promise<number> {
  const res = fakeRes();
  await handleBuildMenuRoutes(fakeReq(headers), res as unknown as http.ServerResponse, '/api/build-menu/projects');
  return res.status;
}

test('a lookalike loopback origin is refused and the menu stays off', async () => {
  configureBuildMenu(false);
  try {
    const token = { 'x-loam-local-token': 'token-token' };
    assert.equal(await status({ origin: 'http://127.0.0.1.evil.example', ...token }), 403);
    assert.equal(await status({ origin: 'http://localhost.evil.example', ...token }), 403);
    assert.equal(await status({ origin: ['http://127.0.0.1', 'https://evil.example'], ...token }), 403);
    assert.equal(await status({ origin: 'http://127.0.0.1:3000', ...token }), 404);
    assert.equal(await status({ origin: 'http://localhost:3000', ...token }), 404);
    assert.equal(await status({ origin: 'http://[::1]:3000', ...token }), 404);
  } finally {
    configureBuildMenu(false);
  }
});
