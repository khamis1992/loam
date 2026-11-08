import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { configureBuildMenu, handleBuildMenuRoutes, sessionFromRequest } from '../../server/routes/buildMenu.js';

function fakeReq(method: string, headers: http.IncomingHttpHeaders): http.IncomingMessage {
  const req = Readable.from([]) as http.IncomingMessage;
  req.method = method;
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

test('capabilities while off stay honest, publish stays missing, and a short token is not a session', async () => {
  configureBuildMenu(false);
  try {
    const capabilities = fakeRes();
    const handledCapabilities = await handleBuildMenuRoutes(
      fakeReq('GET', {}),
      capabilities as unknown as http.ServerResponse,
      '/api/build-menu/capabilities',
    );
    assert.equal(handledCapabilities, true);
    assert.equal(capabilities.status, 200);
    const body = JSON.parse(capabilities.body) as {
      enabled: boolean;
      safariTested: boolean;
      safari: { label: string };
      portableExe: { built: boolean; signed: boolean };
      chrome: { loadUnpacked: string; extensionLoaded: boolean };
      notebookImage: { status: string; digest: string | null };
    };
    assert.equal(body.enabled, false);
    assert.equal(body.safariTested, false);
    assert.equal(body.safari.label, 'source-only');
    assert.equal(body.portableExe.signed, false);
    assert.equal(body.portableExe.built, false);
    assert.equal(body.chrome.loadUnpacked, 'manual');
    assert.equal(body.chrome.extensionLoaded, false);
    assert.equal(body.notebookImage.status, 'unresolved');
    assert.equal(body.notebookImage.digest, null);

    configureBuildMenu(true);
    const publish = fakeRes();
    const handledPublish = await handleBuildMenuRoutes(
      fakeReq('POST', { origin: 'app://agent', 'x-loam-local-token': 'token-token' }),
      publish as unknown as http.ServerResponse,
      '/api/build-menu/publish',
    );
    assert.equal(handledPublish, true);
    assert.equal(publish.status, 404);

    const short = '1234567';
    assert.equal(short.length < 8, true);
    assert.equal(sessionFromRequest(fakeReq('POST', { 'x-loam-local-token': short })), null);
  } finally {
    configureBuildMenu(false);
  }
});
