import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Harness } from '../src/core/harness.js';
import { startServer, type StartedServer } from '../src/web/server.js';

const projectRoot = process.cwd();

interface ApiResponse {
  status: number;
  body: { ok: boolean; data?: unknown; error?: { code: string; message: string } };
}

async function jsonRequest(
  started: StartedServer,
  pathname: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const write = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const response = await fetch(`${started.url}${pathname}`, {
    method,
    headers: {
      ...(write ? { 'Content-Type': 'application/json', 'X-Harness-Token': started.token } : {}),
      ...headers,
    },
    ...(write ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  return { status: response.status, body: await response.json() as ApiResponse['body'] };
}

async function closeServer(started: StartedServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    started.server.close(error => error === undefined ? resolve() : reject(error));
  });
}

async function requestWithHost(url: string, host: string): Promise<{ status: number; body: ApiResponse['body'] }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: '/health',
      method: 'GET',
      headers: { Host: host },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as ApiResponse['body'] });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.end();
  });
}

test('loopback web API manages plugins without weakening core protections', async t => {
  await mkdir(path.join(projectRoot, '.work'), { recursive: true });
  const workDir = await mkdtemp(path.join(projectRoot, '.work', 'web-'));
  const dataDir = path.join(workDir, 'data');
  const fixtureDir = path.join(workDir, 'fixture');
  await mkdir(fixtureDir);
  const fixture = path.join(fixtureDir, 'sample.txt');
  await writeFile(fixture, 'alpha beta\n你好世界\n', 'utf8');

  const staticDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/web');
  const staticFiles = ['index.html', 'app.js', 'style.css', 'manus-routes.json'];
  for (const name of staticFiles) {
    const candidate = path.join(staticDirectory, name);
    assert.ok((await readFile(candidate)).length > 0, `Real built asset missing: ${name}`);
  }

  const first = await startServer(new Harness({ dataDir }), { port: 0 });
  let second: StartedServer | null = null;
  t.after(async () => {
    if (second !== null) await closeServer(second);
    await closeServer(first);
    await rm(workDir, { recursive: true, force: true });
  });

  const session = await jsonRequest(first, '/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.ok, true);
  assert.deepEqual(session.body.data, { token: first.token, dataDir, protocolVersion: '1.0' });

  const health = await fetch(`${first.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const textPlugin = await jsonRequest(first, '/api/plugins', 'POST', { source: path.join(projectRoot, 'plugins', 'text-transform') });
  const filePlugin = await jsonRequest(first, '/api/plugins', 'POST', { source: path.join(projectRoot, 'plugins', 'file-stats') });
  assert.equal(textPlugin.status, 200);
  assert.equal(filePlugin.status, 200);
  assert.equal(textPlugin.body.ok, true);
  assert.equal(filePlugin.body.ok, true);

  const listed = await jsonRequest(first, '/api/plugins');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.ok, true);
  assert.deepEqual(
    (listed.body.data as Array<{ manifest: { id: string } }>).map(record => record.manifest.id).sort(),
    ['demo.file-stats', 'demo.text-transform'],
  );

  const configured = await jsonRequest(first, '/api/plugins/demo.text-transform/config', 'PUT', { config: { caseMode: 'lower' } });
  assert.equal(configured.status, 200);
  const rejectedConfig = await jsonRequest(first, '/api/plugins/demo.text-transform/config', 'PUT', { config: { caseMode: 'sideways' } });
  assert.equal(rejectedConfig.status, 400);
  assert.equal(rejectedConfig.body.ok, false);
  const textDetail = await jsonRequest(first, '/api/plugins/demo.text-transform');
  assert.deepEqual((textDetail.body.data as { config: unknown }).config, { caseMode: 'lower' });

  const disabledRun = await jsonRequest(first, '/api/plugins/demo.text-transform/run', 'POST', {
    capability: 'text.transform', input: { text: 'MiXeD' },
  });
  assert.equal(disabledRun.status, 200);
  assert.equal(disabledRun.body.ok, true);
  assert.equal((disabledRun.body.data as { ok: boolean }).ok, false);

  const enabledText = await jsonRequest(first, '/api/plugins/demo.text-transform/enable', 'POST');
  assert.equal(enabledText.status, 200);
  const transformed = await jsonRequest(first, '/api/plugins/demo.text-transform/run', 'POST', {
    capability: 'text.transform', input: { text: 'MiXeD' },
  });
  assert.deepEqual((transformed.body.data as { data: unknown }).data, { text: 'mixed' });

  await jsonRequest(first, '/api/plugins/demo.file-stats/enable', 'POST');
  const withoutGrant = await jsonRequest(first, '/api/plugins/demo.file-stats/run', 'POST', {
    capability: 'file.stats', input: { path: fixture },
  });
  assert.equal((withoutGrant.body.data as { ok: boolean }).ok, false);
  const granted = await jsonRequest(first, '/api/plugins/demo.file-stats/grants', 'POST', { root: fixtureDir });
  assert.equal(granted.status, 200);
  const withGrant = await jsonRequest(first, '/api/plugins/demo.file-stats/run', 'POST', {
    capability: 'file.stats', input: { path: fixture },
  });
  assert.deepEqual((withGrant.body.data as { data: unknown }).data, { bytes: 24, lines: 2, tokens: 3 });
  const revoked = await jsonRequest(first, '/api/plugins/demo.file-stats/grants', 'DELETE', { root: fixtureDir });
  assert.equal(revoked.status, 200);
  const withoutGrantAgain = await jsonRequest(first, '/api/plugins/demo.file-stats/run', 'POST', {
    capability: 'file.stats', input: { path: fixture },
  });
  assert.equal((withoutGrantAgain.body.data as { ok: boolean }).ok, false);

  second = await startServer(new Harness({ dataDir }), { port: 0 });
  const persisted = await jsonRequest(second, '/api/plugins');
  assert.deepEqual(
    (persisted.body.data as Array<{ manifest: { id: string } }>).map(record => record.manifest.id).sort(),
    ['demo.file-stats', 'demo.text-transform'],
  );
  assert.notEqual(second.token, first.token);

  const badToken = await jsonRequest(first, '/api/plugins/demo.text-transform/disable', 'POST', {}, { 'X-Harness-Token': 'not-the-token' });
  assert.equal(badToken.status, 403);
  assert.equal(badToken.body.error?.code, 'INVALID_TOKEN');
  const badOrigin = await jsonRequest(first, '/api/plugins/demo.text-transform/disable', 'POST', {}, { Origin: 'http://localhost:4317' });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.body.error?.code, 'INVALID_ORIGIN');
  const badHost = await requestWithHost(first.url, 'localhost:4317');
  assert.equal(badHost.status, 400);
  assert.equal(badHost.body.error?.code, 'INVALID_HOST');

  const tooLarge = await jsonRequest(first, '/api/plugins', 'POST', { source: 'x'.repeat(1024 * 1024) });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error?.code, 'BODY_TOO_LARGE');

  for (const name of staticFiles) {
    const route = name === 'index.html' ? '/' : `/${name}`;
    const staticResponse = await fetch(`${first.url}${route}`);
    assert.equal(staticResponse.status, 200, route);
    assert.match(staticResponse.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(staticResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(staticResponse.headers.get('access-control-allow-origin'), null);
    const contents = await staticResponse.text();
    if (name === 'index.html') { assert.match(contents, /Local Agent Harness/); assert.match(contents, /type="module" src="\/app.js"/); }
    if (name === 'app.js') { assert.match(contents, /X-Harness-Token/); assert.match(contents, /\/api\/session/); }
    if (name === 'manus-routes.json') assert.deepEqual(JSON.parse(contents).routes.map((route: {path: string}) => route.path), ['/']);
  }
  const traversal = await fetch(`${first.url}/%2e%2e%2fpackage.json`);
  assert.equal(traversal.status, 404);
});
