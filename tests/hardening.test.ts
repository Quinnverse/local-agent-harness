import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { Harness } from '../src/core/harness.js';

const root = process.cwd();
async function setup(t: import('node:test').TestContext) {
  const temp = await mkdtemp(path.join(root, '.work/hardening-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  return { temp, host: new Harness({ dataDir: path.join(temp, 'data') }) };
}
async function fixture(temp: string, id: string, entry: string, patch: Record<string, unknown> = {}) {
  const dir = path.join(temp, 'source', id);
  await mkdir(dir, { recursive: true });
  const manifest = {
    id, name: id, version: '1.0.0', protocolVersion: '1.0', entry: 'index.js', permissions: [],
    configSchema: { type: 'object', additionalProperties: false },
    capabilities: [{ name: 'sample.echo', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }], ...patch
  };
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(dir, 'index.js'), entry);
  return dir;
}

test('exception and process crash have distinct codes, and another plugin still succeeds', async t => {
  const { temp, host } = await setup(t);
  for (const [id, entry, code] of [
    ['fixture.throw', 'export function execute(){throw new Error("secret-value");}', 'PLUGIN_EXECUTION_FAILED'],
    ['fixture.crash', 'export function execute(){process.exit(17);}', 'PLUGIN_CRASHED'],
    ['fixture.output', 'export function execute(){return undefined;}', 'INVALID_OUTPUT']
  ] as const) {
    await host.install(await fixture(temp, id, entry)); await host.enable(id);
    const result = await host.run(id, 'sample.echo', {});
    assert.equal(result.ok, false); assert.equal(result.error?.code, code);
    assert.ok(!JSON.stringify(result).includes('secret-value'));
  }
  await host.install(path.join(root, 'plugins/text-transform')); await host.enable('demo.text-transform');
  assert.deepEqual((await host.run('demo.text-transform', 'text.transform', { text: 'still alive' })).data, { text: 'STILL ALIVE' });
});

test('disabled, invalid input, unknown capability and timeout validation are exact errors', async t => {
  const { host } = await setup(t);
  await host.install(path.join(root, 'plugins/text-transform'));
  assert.equal((await host.run('demo.text-transform', 'text.transform', { text: 'x' })).error?.code, 'PLUGIN_DISABLED');
  await host.enable('demo.text-transform');
  assert.equal((await host.run('demo.text-transform', 'text.transform', { text: 1 })).error?.code, 'INVALID_INPUT');
  assert.equal((await host.run('demo.text-transform', 'missing', {})).error?.code, 'CAPABILITY_NOT_FOUND');
  assert.equal((await host.run('demo.text-transform', 'text.transform', { text: 'x' }, { timeoutMs: 0 })).error?.code, 'INVALID_TIMEOUT');
});

test('file stats cover empty, CRLF, CR and trailing newline, and revocation is enforced', async t => {
  const { temp, host } = await setup(t);
  const dir = path.join(temp, 'files'); await mkdir(dir);
  await host.install(path.join(root, 'plugins/file-stats')); await host.enable('demo.file-stats');
  const file = path.join(dir, 'input.txt'); await writeFile(file, '');
  assert.equal((await host.run('demo.file-stats', 'file.stats', { path: file })).error?.code, 'PERMISSION_DENIED');
  await host.grant('demo.file-stats', dir);
  for (const [text, lines, tokens] of [['', 0, 0], ['a\r\nb\r\n', 2, 2], ['a\rb', 2, 2], ['a\n', 1, 1], ['\n', 1, 0]] as const) {
    await writeFile(file, text);
    assert.deepEqual((await host.run('demo.file-stats', 'file.stats', { path: file })).data, { bytes: Buffer.byteLength(text), lines, tokens });
  }
  await host.revoke('demo.file-stats', dir);
  assert.equal((await host.run('demo.file-stats', 'file.stats', { path: file })).error?.code, 'PERMISSION_DENIED');
});

test('rejected symlink package leaves no registered plugin and can be retried after fixing', async t => {
  const { temp, host } = await setup(t);
  const dir = await fixture(temp, 'fixture.install', 'export function execute(){return {}; }');
  await symlink(path.join(dir, 'index.js'), path.join(dir, 'link.js'));
  await assert.rejects(host.install(dir), (e: unknown) => (e as { code: string }).code === 'INVALID_PACKAGE');
  assert.equal((await host.list()).length, 0);
  await rm(path.join(dir, 'link.js'));
  const record = await host.install(dir); assert.equal(record.manifest.id, 'fixture.install');
});

test('corrupted registry is not overwritten by a management operation', async t => {
  const { host } = await setup(t);
  await mkdir(host.dataDir, { recursive: true });
  const registry = path.join(host.dataDir, 'registry.json'); await writeFile(registry, '{not json');
  await assert.rejects(host.install(path.join(root, 'plugins/text-transform')), (e: unknown) => (e as { code: string }).code === 'STATE_CORRUPT');
  assert.equal(await readFile(registry, 'utf8'), '{not json');
});

test('valid plugin ID constructor is not mistaken for an inherited registry property', async t => {
  const { temp, host } = await setup(t);
  await host.install(path.join(root, 'plugins/text-transform'));
  await host.install(await fixture(temp, 'constructor', 'export function execute(){return {ok:true};}'));
  await host.enable('constructor');
  assert.deepEqual((await host.run('constructor', 'sample.echo', {})).data, { ok: true });
});

test('CPU-bound plugin ignoring SIGTERM is killed on timeout and its PID no longer exists', async t => {
  const { temp, host } = await setup(t);
  const source = await fixture(temp, 'fixture.cpu-timeout', 'process.on("SIGTERM",()=>{}); export function execute(){while(true){}}');
  await host.install(source); await host.enable('fixture.cpu-timeout');
  const result = await host.run('fixture.cpu-timeout', 'sample.echo', {}, { timeoutMs: 250 });
  assert.equal(result.error?.code, 'PLUGIN_TIMEOUT');
  assert.equal(result.runtime?.terminated, true);
  assert.ok(result.runtime?.pid);
  assert.throws(() => process.kill(result.runtime!.pid, 0), (e: unknown) => (e as { code: string }).code === 'ESRCH');
  assert.ok(result.durationMs < 2000, 'timeout should not leave an unbounded process');
});

test('a legal 51ms timeout is accepted, not mistaken for a 50ms multiple restriction', async t => {
  const { host } = await setup(t);
  await host.install(path.join(root, 'plugins/text-transform')); await host.enable('demo.text-transform');
  const result = await host.run('demo.text-transform', 'text.transform', { text: 'x' }, { timeoutMs: 51 });
  assert.notEqual(result.error?.code, 'INVALID_TIMEOUT');
  assert.ok(result.ok || result.error?.code === 'PLUGIN_TIMEOUT');
});
