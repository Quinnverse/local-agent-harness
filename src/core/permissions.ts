import { realpath, stat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { PluginRecord } from '../protocol/types.js';
import { HarnessError } from './errors.js';
import { inside } from './package.js';

export async function readGrantedText(record: PluginRecord, file: unknown, limit: unknown = 1_048_576): Promise<{ text: string; bytes: number }> {
  if (!record.manifest.permissions.includes('files.read') || record.grants.readRoots.length === 0) throw new HarnessError('PERMISSION_DENIED', '插件未获得宿主文件读取授权。');
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw new HarnessError('INVALID_PATH', '文件路径必须是绝对路径。');
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1_048_576) throw new HarnessError('INVALID_INPUT', '文件读取上限必须为 1..1048576 字节。');
  let actual: string;
  try { actual = await realpath(file); }
  catch { throw new HarnessError('FILE_NOT_FOUND', '文件不存在或无法读取。'); }
  if (!record.grants.readRoots.some(root => inside(root, actual))) throw new HarnessError('PERMISSION_DENIED', '文件不在用户授权目录内。');
  try {
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new HarnessError('INVALID_FILE', '只能读取普通文本文件。');
      if (info.size > limit) throw new HarnessError('FILE_TOO_LARGE', '文件超过允许大小。');
      const buffer = Buffer.alloc(limit + 1);
      let bytes = 0;
      while (bytes <= limit) {
        const part = await handle.read(buffer, bytes, buffer.length - bytes, null);
        if (part.bytesRead === 0) break;
        bytes += part.bytesRead;
      }
      if (bytes > limit) throw new HarnessError('FILE_TOO_LARGE', '文件超过允许大小。');
      try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)), bytes }; }
      catch { throw new HarnessError('INVALID_ENCODING', '首版仅支持有效 UTF-8 文本。'); }
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError('FILE_READ_FAILED', '文件读取失败。');
  }
}

export async function canonicalDirectory(root: string): Promise<string> {
  try {
    const actual = await realpath(root);
    if (!(await stat(actual)).isDirectory()) throw new Error();
    return actual;
  } catch { throw new HarnessError('INVALID_PATH', '授权范围必须是存在的目录。'); }
}
