import { mkdir, readFile, writeFile, rename, unlink, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginRecord } from '../protocol/types.js';
import { HarnessError, hasCode } from './errors.js';

interface State { version: 1; plugins: Record<string, PluginRecord> }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class Store {
  constructor(public readonly dataDir: string) {}
  private get registry() { return path.join(this.dataDir, 'registry.json'); }
  private get lock() { return path.join(this.dataDir, 'registry.lock'); }

  async read(): Promise<State> {
    try {
      const data: unknown = JSON.parse(await readFile(this.registry, 'utf8'));
      if (typeof data !== 'object' || data === null || !('version' in data) || data.version !== 1 || !('plugins' in data) || typeof data.plugins !== 'object' || data.plugins === null || Array.isArray(data.plugins)) throw new Error();
      for (const [id, record] of Object.entries(data.plugins)) {
        if (!record || typeof record !== 'object' || record.manifest?.id !== id || typeof record.enabled !== 'boolean' || typeof record.packagePath !== 'string' || typeof record.config !== 'object' || !Array.isArray(record.grants?.readRoots)) throw new Error();
      }
      return data as State;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return { version: 1, plugins: Object.create(null) as Record<string, PluginRecord> };
      throw new HarnessError('STATE_CORRUPT', '持久化状态无效；宿主不会覆盖原文件。请恢复备份。');
    }
  }

  async transaction<T>(operation: (state: State) => T | Promise<T>): Promise<T> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const release = await this.acquire();
    try {
      const state = await this.read();
      const result = await operation(state);
      const temporary = path.join(this.dataDir, `.registry-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.registry);
      } finally { await unlink(temporary).catch(() => {}); }
      return result;
    } finally { await release(); }
  }

  private async acquire(): Promise<() => Promise<void>> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const handle = await open(this.lock, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
        finally { await handle.close(); }
        return async () => { await unlink(this.lock).catch(() => {}); };
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw new HarnessError('STATE_WRITE_FAILED', '无法锁定持久化目录。');
        try {
          const info = await stat(this.lock);
          if (Date.now() - info.mtimeMs > 200) {
            const owner = JSON.parse(await readFile(this.lock, 'utf8')) as { pid: number };
            if (Number.isInteger(owner.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0); }
              catch (probe) { if (hasCode(probe, 'ESRCH')) await unlink(this.lock).catch(() => {}); }
            }
          }
        } catch { /* A concurrent writer may have released the lock. Retry. */ }
        await delay(25);
      }
    }
    throw new HarnessError('STATE_BUSY', '状态正在由其他宿主进程更新，请稍后重试。');
  }
}
