import { Harness } from '../dist/src/core/harness.js';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function digest(dir) {
  const hash = createHash('sha256');
  async function walk(current) {
    for (const item of (await readdir(current, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const target = path.join(current, item.name);
      if (item.isDirectory()) await walk(target);
      else { hash.update(path.relative(dir, target)); hash.update(await readFile(target)); }
    }
  }
  await walk(dir); return hash.digest('hex');
}
await mkdir(path.join(root, '.work'), { recursive: true });
const dataDir = await mkdtemp(path.join(root, '.work/extension-'));
try {
  const before = await digest(path.join(root, 'src'));
  const host = new Harness({ dataDir });
  await host.install(path.join(root, 'outputs/third-plugin'));
  await host.configure('demo.reverse', {});
  await host.enable('demo.reverse');
  const result = await host.run('demo.reverse', 'text.reverse', { text: 'agent' });
  assert.equal(result.ok, true); assert.deepEqual(result.data, { text: 'tnega' });
  const after = await digest(path.join(root, 'src'));
  assert.equal(after, before);
  const evidence = { status: 'PASS', node: process.version, checkedAt: new Date().toISOString(), beforeSourceSha256: before, afterSourceSha256: after, hostSourceUnchanged: before === after, pluginSource: 'outputs/third-plugin', result };
  await writeFile(path.join(root, 'outputs/extension-verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally { await rm(dataDir, { recursive: true, force: true }); }
