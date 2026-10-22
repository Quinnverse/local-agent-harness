import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = path.join(root, '.work');
await mkdir(work, { recursive: true });
const clean = await mkdtemp(path.join(work, 'clean-room-'));
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'plugins', 'tests', 'scripts']) {
  await cp(path.join(root, name), path.join(clean, name), { recursive: true, filter: source => !source.split(path.sep).includes('dist') && !source.split(path.sep).includes('node_modules') });
}
await mkdir(path.join(clean, '.work/sample-files'), { recursive: true });
const env = { ...process.env, npm_config_cache: path.join(root, '.work/npm-cache'), HARNESS_DATA_DIR: path.join(clean, '.work/user-data') };
const records = [];
function run(command, args) {
  const result = spawnSync(command, args, { cwd: clean, env, encoding: 'utf8', maxBuffer: 8_388_608, timeout: 120_000 });
  const record = { command: [command === process.execPath ? 'node' : command, ...args].join(' '), exitCode: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
  records.push(record);
  assert.equal(result.status, 0, `${record.command} failed: ${record.stderr}\n${record.stdout}`);
  return result.stdout;
}
let failure;
try {
  run('npm', ['ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund']);
  run('npm', ['run', 'check']);
  run('npm', ['test']);
  const cli = (...args) => JSON.parse(run(process.execPath, ['dist/src/cli.js', ...args]));
  cli('plugins', 'install', './plugins/text-transform');
  cli('plugins', 'install', './plugins/file-stats');
  cli('plugins', 'configure', 'demo.text-transform', '--config-json', '{"caseMode":"lower"}');
  cli('plugins', 'enable', 'demo.text-transform');
  const text = cli('plugins', 'run', 'demo.text-transform', '--capability', 'text.transform', '--input-json', '{"text":"Hello 世界"}');
  assert.deepEqual(text.data, { text: 'hello 世界' });
  const files = path.join(clean, '.work/sample-files');
  await writeFile(path.join(files, 'sample.txt'), 'alpha beta\n你好世界\n');
  cli('plugins', 'configure', 'demo.file-stats', '--config-json', '{"maxBytes":1048576}');
  cli('permissions', 'grant', 'demo.file-stats', '--read-root', files);
  cli('plugins', 'enable', 'demo.file-stats');
  const stats = cli('plugins', 'run', 'demo.file-stats', '--capability', 'file.stats', '--input-json', JSON.stringify({ path: path.join(files, 'sample.txt') }));
  assert.deepEqual(stats.data, { bytes: 24, lines: 2, tokens: 3 });
  // Each CLI command ran in a fresh process: persistence was exercised, not mocked.
  const persisted = cli('plugins', 'show', 'demo.text-transform');
  assert.deepEqual(persisted.config, { caseMode: 'lower' });
  const service = spawn('npm', ['start', '--', '--port', '0'], { cwd: clean, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let serviceOutput = '';
  let serviceErrors = '';
  service.stdout.on('data', chunk => { serviceOutput += String(chunk); });
  service.stderr.on('data', chunk => { serviceErrors += String(chunk); });
  const exited = new Promise(resolve => service.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('npm start did not become ready')), 10000);
      const inspect = () => {
        const match = /"url":\s*"(http:\/\/127\.0\.0\.1:\d+)"/.exec(serviceOutput);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      service.stdout.on('data', inspect);
      service.once('error', error => { clearTimeout(timer); reject(error); });
      service.once('exit', () => { clearTimeout(timer); reject(new Error('npm start exited before readiness')); });
      inspect();
    });
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true });
    const page = await fetch(url); assert.match(await page.text(), /Local Agent Harness/);
    const persistedList = await fetch(`${url}/api/plugins`);
    assert.equal((await persistedList.json()).data.length, 2);
    records.push({ command: 'npm start -- --port 0', startup: 'PASS', health: 'PASS', actualUrl: url, restoredPlugins: 2, stdout: serviceOutput, stderr: serviceErrors });
  } finally {
    if (service.pid) process.kill(-service.pid, 'SIGTERM');
    await exited;
  }
} catch (error) { failure = String(error); }
await writeFile(path.join(root, 'outputs/clean-install-verification.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', checkedAt: new Date().toISOString(), node: process.version, platform: process.platform, freshDependenciesBuildAndState: true, freshOperatingSystem: false, directory: clean, failure, commands: records }, null, 2) + '\n');
console.log(JSON.stringify({ status: failure ? 'FAIL' : 'PASS', cleanDirectory: clean, commands: records.length, failure }, null, 2));
if (failure) process.exitCode = 1;
