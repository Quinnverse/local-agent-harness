import { mkdir, copyFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const name of ['text-transform', 'file-stats']) {
  const dir = path.join(root, 'plugins', name);
  await mkdir(path.join(dir, 'dist'), { recursive: true });
  await copyFile(path.join(root, 'dist/plugins', name, 'src/index.js'), path.join(dir, 'dist/index.js'));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: `harness-plugin-${name}`, version: '1.0.0', type: 'module', private: true }, null, 2) + '\n');
}
for (const name of ['index.html', 'style.css', 'manus-routes.json']) {
  const source = path.join(root, 'src/web', name);
  try { await access(source); } catch { continue; }
  await mkdir(path.join(root, 'dist/src/web'), { recursive: true });
  await copyFile(source, path.join(root, 'dist/src/web', name));
}
console.log('Built host, isolated runner and two independent plugin packages.');
