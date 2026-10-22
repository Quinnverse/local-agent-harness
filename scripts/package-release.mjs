import { mkdir, mkdtemp, readdir, lstat, copyFile, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Distribution tooling only. It never removes source files, user data or old archives.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let output = path.join(root, 'outputs/local-agent-harness-final.tar.gz');
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--output' || !args[i + 1]) throw new Error('Usage: node scripts/package-release.mjs [--output archive.tar.gz]');
  output = path.resolve(args[++i]);
}
if (path.basename(output) === 'local-agent-harness.tar.gz') throw new Error('The original comparison archive must not be overwritten.');
try { await access(output); throw new Error('Output already exists; choose a new filename instead of overwriting an attested archive.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const stagingParent = path.join(root, '.work/release');
await mkdir(stagingParent, { recursive: true });
const stage = await mkdtemp(path.join(stagingParent, 'staging-'));
const bannedParts = new Set(['.work', '.manus', '.git', 'node_modules', '.npm', '.cache', 'dist', '.DS_Store']);
const files = [];
const machinePath = /[/](?:Users|home)[/][^\s/]+[/]|[/](?:private[/])?(?:tmp|var)[/][A-Za-z0-9_.-]+/;
const credential = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{35}\b|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{24,}\b/;
function safeRelative(relative) {
  const parts = relative.split('/');
  if (path.isAbsolute(relative) || parts.some(x => x === '..' || bannedParts.has(x)) || relative.includes('\\')) throw new Error(`Disallowed release member: ${relative}`);
  if (/\.(?:log|tmp|pem|key|p12|pfx)$/.test(relative) || /(?:^|\/)\.env(?:\.|$)/.test(relative)) throw new Error(`Sensitive or transient member: ${relative}`);
}
async function copy(sourceRelative, targetRelative = sourceRelative) {
  safeRelative(targetRelative);
  const source = path.join(root, sourceRelative);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Release source must be a regular file: ${sourceRelative}`);
  const buffer = await readFile(source);
  if (!sourceRelative.endsWith('.png')) {
    const text = buffer.toString('utf8');
    if (machinePath.test(text)) throw new Error(`Concrete machine path found; classify or sanitize the document explicitly: ${sourceRelative}`);
    if (credential.test(text)) throw new Error(`Credential pattern found: ${sourceRelative}`);
  }
  const target = path.join(stage, targetRelative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  files.push({ path: targetRelative, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
}
async function tree(relative, extensions) {
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (bannedParts.has(entry.name)) continue;
    const item = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in release source tree: ${item}`);
    if (entry.isDirectory()) await tree(item, extensions);
    else if (entry.isFile()) {
      if (!extensions.has(path.extname(entry.name))) throw new Error(`Unexpected source-tree file; do not silently package it: ${item}`);
      await copy(item);
    } else throw new Error(`Special file in source tree: ${item}`);
  }
}
for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', '.gitignore']) await copy(file);
await tree('src', new Set(['.ts', '.html', '.css', '.json']));
await tree('tests', new Set(['.ts', '.json', '.txt', '.mjs', '.js']));
for (const plugin of ['text-transform', 'file-stats']) {
  await copy(`plugins/${plugin}/manifest.json`);
  await copy(`plugins/${plugin}/package.json`);
  await tree(`plugins/${plugin}/src`, new Set(['.ts']));
}
for (const file of ['build.mjs', 'verify-extension.mjs', 'verify-clean-install.mjs', 'package-release.mjs']) await copy(`scripts/${file}`);
for (const file of ['plugin-protocol.md', 'plugin-development.md', 'security.md', 'engineering-sources.md', 'implementation-contract.md', 'release-packaging.md']) await copy(`docs/${file}`);
for (const file of ['manifest.json', 'package.json', 'index.mjs']) await copy(`outputs/third-plugin/${file}`);
// Deliberately do not walk outputs. Never ship registry snapshots or old machine logs.
let baselineSource = 'docs/release-baseline.md';
try { await access(path.join(root, baselineSource)); }
catch (error) { if (error.code !== 'ENOENT') throw error; baselineSource = 'outputs/acceptance-report.md'; }
await copy(baselineSource, 'outputs/acceptance-report.md');
for (const file of ['text-transform.png', 'file-statistics.png']) await copy(`outputs/screenshots/${file}`);
files.sort((a,b) => a.path.localeCompare(b.path));
const fileList = path.join(stagingParent, `${path.basename(stage)}-files.txt`);
await writeFile(fileList, files.map(x => x.path).join('\n') + '\n');
await mkdir(path.dirname(output), { recursive: true });
const tar = spawnSync('tar', ['-czf', output, '-C', stage, '-T', fileList], { env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8' });
if (tar.error || tar.status !== 0) throw new Error(`tar failed; no successful-release claim: ${tar.error?.message || tar.stderr}`);
const listed = spawnSync('tar', ['-tzf', output], { encoding: 'utf8' });
if (listed.status !== 0) throw new Error('Archive could not be read back.');
const members = listed.stdout.trim().split('\n').filter(Boolean);
for (const member of members) safeRelative(member);
if (members.length !== files.length || new Set(members).size !== files.length) throw new Error('Archive inventory mismatch.');
const sha256 = createHash('sha256').update(await readFile(output)).digest('hex');
await writeFile(`${output}.sha256`, `${sha256}  ${path.basename(output)}\n`);
const report = { status: 'PACKAGED_NOT_YET_RUNTIME_ATTESTED', archive: output, sha256, fileCount: files.length, stagingDirectory: stage, excludedTypes: ['runtime data and registry snapshots', 'cache and node_modules', 'logs and temporary files', 'all generated dist and test output', 'old archives', 'machine-identifying screenshots and raw historical evidence'], files };
await writeFile(path.join(stagingParent, 'packaging-manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, archive: output, sha256, fileCount: files.length, stagingDirectory: stage }, null, 2));
