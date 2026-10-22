import { readFile, realpath, stat, lstat, readdir, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { HarnessError, hasCode } from './errors.js';
import { validateManifest } from '../protocol/schemas.js';
import type { PluginManifest } from '../protocol/types.js';

export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function entryPath(root: string, entry: string): Promise<string> {
  if (path.isAbsolute(entry) || entry.includes('\\') || entry.includes('\0')) throw new HarnessError('INVALID_ENTRY', '入口必须是包内相对路径。');
  const candidate = path.resolve(root, entry);
  if (!inside(root, candidate) || candidate === root) throw new HarnessError('INVALID_ENTRY', '入口不得越出插件包。');
  try {
    const actual = await realpath(candidate);
    if (!inside(await realpath(root), actual)) throw new HarnessError('INVALID_ENTRY', '入口链接越出插件包。');
    if (!(await stat(actual)).isFile()) throw new HarnessError('ENTRY_NOT_FOUND', '插件入口不是普通文件。');
    if (!['.js', '.mjs', '.cjs'].includes(path.extname(actual))) throw new HarnessError('INVALID_ENTRY', '入口必须是已构建的 JavaScript 文件。');
    return actual;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError('ENTRY_NOT_FOUND', '插件入口不存在或不可读取。');
  }
}

export async function inspectPackage(source: string): Promise<{ root: string; manifest: PluginManifest }> {
  let root: string;
  try { root = await realpath(source); if (!(await stat(root)).isDirectory()) throw new Error(); }
  catch { throw new HarnessError('INVALID_PACKAGE', '请选择可读取的本地插件目录。'); }
  let value: unknown;
  try {
    const manifestPath = path.join(root, 'manifest.json');
    if ((await lstat(manifestPath)).isSymbolicLink() || (await stat(manifestPath)).size > 65_536) throw new Error();
    value = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch { throw new HarnessError('INVALID_MANIFEST', 'manifest.json 缺失、过大或无法解析。'); }
  const manifest = validateManifest(value);
  await entryPath(root, manifest.entry);
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { type?: string };
    if (pkg.type !== 'module') throw new Error();
  } catch { throw new HarnessError('INVALID_PACKAGE', '首版插件必须包含 type=module 的 package.json。'); }
  return { root, manifest };
}

export async function copyPackage(source: string, destination: string): Promise<void> {
  let files = 0;
  let total = 0;
  const walk = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true, mode: 0o700 });
    for (const item of await readdir(from, { withFileTypes: true })) {
      if (['node_modules', '.git', '.DS_Store'].includes(item.name)) continue;
      const input = path.join(from, item.name);
      const output = path.join(to, item.name);
      const info = await lstat(input);
      if (info.isSymbolicLink()) throw new HarnessError('INVALID_PACKAGE', '首版插件包不允许符号链接。');
      if (info.isDirectory()) {
        files += 1;
        if (files > 256) throw new HarnessError('PACKAGE_TOO_LARGE', '插件包目录或文件过多。');
        await walk(input, output);
      } else if (info.isFile()) {
        files += 1; total += info.size;
        if (files > 256 || total > 16_777_216) throw new HarnessError('PACKAGE_TOO_LARGE', '插件包超过 256 项或 16 MiB 上限。');
        await copyFile(input, output);
      } else throw new HarnessError('INVALID_PACKAGE', '插件包包含特殊文件。');
    }
  };
  try { await walk(source, destination); }
  catch (error) {
    if (error instanceof HarnessError) throw error;
    if (hasCode(error, 'EACCES')) throw new HarnessError('INSTALL_FAILED', '插件包无法读取。');
    throw new HarnessError('INSTALL_FAILED', '复制插件包失败；未注册插件。');
  }
}
