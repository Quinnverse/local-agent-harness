import { mkdir, rename, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { copyPackage, inspectPackage } from './package.js';
import { canonicalDirectory } from './permissions.js';
import { effectiveConfig, validateManifest } from '../protocol/schemas.js';
import type { PluginRecord, ExecutionResult } from '../protocol/types.js';
import { HarnessError, publicError } from './errors.js';
import { executePlugin } from './executor.js';

export class Harness {
  readonly dataDir: string;
  private readonly store: Store;
  private readonly timeoutMs: number;

  constructor(options: { dataDir?: string; timeoutMs?: number } = {}) {
    this.dataDir = path.resolve(options.dataDir ?? process.env.HARNESS_DATA_DIR ?? path.join(os.homedir(), '.local-agent-harness'));
    this.store = new Store(this.dataDir);
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async list(): Promise<PluginRecord[]> {
    return Object.values((await this.store.read()).plugins).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  async show(id: string): Promise<PluginRecord> {
    const record = (await this.store.read()).plugins[id];
    if (!record || record.manifest?.id !== id) throw new HarnessError('PLUGIN_NOT_FOUND', '插件尚未安装。');
    return record;
  }

  async install(source: string): Promise<PluginRecord> {
    const inspected = await inspectPackage(source);
    return this.store.transaction(async state => {
      if (Object.hasOwn(state.plugins, inspected.manifest.id)) throw new HarnessError('DUPLICATE_PLUGIN_ID', '插件 ID 已安装；首版不支持覆盖更新。');
      const packages = path.join(this.dataDir, 'plugins');
      const staging = path.join(this.dataDir, '.staging');
      await mkdir(packages, { recursive: true, mode: 0o700 });
      await mkdir(staging, { recursive: true, mode: 0o700 });
      // Under the shared write lock, no active installer owns old staging directories.
      for (const item of await readdir(staging)) await rm(path.join(staging, item), { recursive: true, force: true });
      const referenced = new Set(Object.values(state.plugins).map(plugin => plugin.packagePath));
      for (const item of await readdir(packages)) {
        const candidate = path.join(packages, item);
        if (!referenced.has(candidate)) await rm(candidate, { recursive: true, force: true });
      }
      const key = `${inspected.manifest.id}-${randomUUID()}`;
      const temporary = path.join(staging, key);
      const destination = path.join(packages, key);
      try {
        await copyPackage(inspected.root, temporary);
        const checked = await inspectPackage(temporary);
        if (JSON.stringify(checked.manifest) !== JSON.stringify(inspected.manifest)) throw new HarnessError('INSTALL_FAILED', '插件包在安装期间变化。');
        let config: Record<string, unknown> = {};
        try { config = effectiveConfig(checked.manifest.configSchema, {}); }
        catch (error) { if (!(error instanceof HarnessError) || error.code !== 'INVALID_CONFIG') throw error; }
        await rename(temporary, destination);
        const record: PluginRecord = { manifest: checked.manifest, enabled: false, config, grants: { readRoots: [] }, installedAt: new Date().toISOString(), packagePath: destination };
        state.plugins[record.manifest.id] = record;
        return record;
      } catch (error) {
        await rm(destination, { recursive: true, force: true }).catch(() => {});
        throw error;
      } finally { await rm(temporary, { recursive: true, force: true }).catch(() => {}); }
    });
  }

  private async change(id: string, operation: (record: PluginRecord) => void | Promise<void>): Promise<PluginRecord> {
    return this.store.transaction(async state => {
      const record = state.plugins[id];
      if (!record || record.manifest?.id !== id) throw new HarnessError('PLUGIN_NOT_FOUND', '插件尚未安装。');
      await operation(record);
      return record;
    });
  }

  async configure(id: string, config: Record<string, unknown>): Promise<PluginRecord> {
    return this.change(id, record => { record.config = effectiveConfig(record.manifest.configSchema, config); });
  }

  async enable(id: string): Promise<PluginRecord> {
    return this.change(id, record => {
      validateManifest(record.manifest);
      record.config = effectiveConfig(record.manifest.configSchema, record.config);
      record.enabled = true;
    });
  }

  async disable(id: string): Promise<PluginRecord> {
    return this.change(id, record => { record.enabled = false; });
  }

  async grant(id: string, root: string): Promise<PluginRecord> {
    const actual = await canonicalDirectory(root);
    return this.change(id, record => {
      if (!record.manifest.permissions.includes('files.read')) throw new HarnessError('PERMISSION_NOT_DECLARED', '插件没有声明文件读取能力。');
      if (!record.grants.readRoots.includes(actual)) record.grants.readRoots.push(actual);
    });
  }

  async revoke(id: string, root: string): Promise<PluginRecord> {
    const absolute = path.resolve(root);
    let actual = absolute;
    try { actual = await canonicalDirectory(root); } catch { /* Allow revoking a deleted directory. */ }
    return this.change(id, record => { record.grants.readRoots = record.grants.readRoots.filter(item => item !== actual && item !== absolute); });
  }

  async run(id: string, capability: string, input: unknown, options: { timeoutMs?: number } = {}): Promise<ExecutionResult> {
    const started = Date.now();
    try {
      const record = await this.show(id);
      if (!record.enabled) throw new HarnessError('PLUGIN_DISABLED', '插件未启用，不能发起新的执行。');
      validateManifest(record.manifest);
      record.config = effectiveConfig(record.manifest.configSchema, record.config);
      const timeout = options.timeoutMs ?? this.timeoutMs;
      if (!Number.isInteger(timeout) || timeout < 50 || timeout > 30_000) throw new HarnessError('INVALID_TIMEOUT', '超时必须在 50..30000 毫秒之间。');
      return await executePlugin(record, capability, structuredClone(input), timeout);
    } catch (error) {
      return { executionId: randomUUID(), pluginId: id, capability, ok: false, durationMs: Date.now() - started, error: publicError(error) };
    }
  }
}
