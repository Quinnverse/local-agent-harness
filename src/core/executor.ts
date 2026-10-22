import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExecutionResult, PluginRecord, PublicError } from '../protocol/types.js';
import { MAX_MESSAGE_BYTES, validateData } from '../protocol/schemas.js';
import { entryPath } from './package.js';
import { readGrantedText } from './permissions.js';
import { HarnessError, publicError } from './errors.js';

export async function executePlugin(record: PluginRecord, capabilityName: string, input: unknown, timeoutMs: number): Promise<ExecutionResult> {
  const executionId = randomUUID();
  const start = Date.now();
  const base = { executionId, pluginId: record.manifest.id, capability: capabilityName };
  const capability = record.manifest.capabilities.find(item => item.name === capabilityName);
  if (!capability) throw new HarnessError('CAPABILITY_NOT_FOUND', '插件未声明此能力。');
  validateData(capability.inputSchema, input, 'INVALID_INPUT');
  const entry = await entryPath(record.packagePath, record.manifest.entry);
  return new Promise(resolve => {
    const child = fork(new URL('../runtime/plugin-runner.js', import.meta.url), [], {
      cwd: record.packagePath,
      env: { LANG: 'C.UTF-8' },
      execArgv: ['--max-old-space-size=128'],
      silent: true,
      serialization: 'json'
    });
    let outcome: { ok: true; data: unknown } | { ok: false; error: PublicError } | undefined;
    let resolved = false;
    let loggedBytes = 0;
    let brokerCalls = 0;
    const finish = (terminated: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
      const result = outcome ?? { ok: false as const, error: { code: 'PLUGIN_CRASHED', message: '插件进程在返回结果前退出。' } };
      resolve({ ...base, ...result, durationMs: Date.now() - start, ...(child.pid ? { runtime: { pid: child.pid, terminated } } : {}) });
    };
    const stop = (result: NonNullable<typeof outcome>) => {
      if (outcome || resolved) return;
      outcome = result;
      child.stdout?.destroy(); child.stderr?.destroy();
      if (!child.pid) { finish(false); return; }
      try { child.kill('SIGKILL'); }
      catch { outcome = { ok: false, error: { code: 'TERMINATION_FAILED', message: '无法终止插件执行进程。' } }; finish(false); }
    };
    const timer = setTimeout(() => stop({ ok: false, error: { code: 'PLUGIN_TIMEOUT', message: '插件执行超时，执行进程已终止。' } }), timeoutMs);
    const accountLog = (chunk: Buffer | string) => {
      loggedBytes += Buffer.byteLength(chunk);
      if (loggedBytes > 65_536) stop({ ok: false, error: { code: 'OUTPUT_LIMIT', message: '插件日志超过 64 KiB 上限。' } });
    };
    child.stdout?.on('data', accountLog); child.stderr?.on('data', accountLog);
    child.on('spawn', () => {
      child.send({ type: 'invoke', entry, request: { capability: capabilityName, input, config: record.config } }, error => {
        if (error) stop({ ok: false, error: { code: 'PLUGIN_START_FAILED', message: '无法发送插件执行请求。' } });
      });
    });
    child.on('error', () => stop({ ok: false, error: { code: 'PLUGIN_START_FAILED', message: '无法启动插件执行进程。' } }));
    child.on('exit', () => finish(true));
    child.on('message', (message: unknown) => {
      if (outcome || resolved) return;
      try {
        if (Buffer.byteLength(JSON.stringify(message)) > MAX_MESSAGE_BYTES || !message || typeof message !== 'object' || !('type' in message)) throw new HarnessError('INVALID_OUTPUT', '插件协议消息无效或过大。');
        const msg = message as Record<string, unknown>;
        if (msg.type === 'result') {
          validateData(capability.outputSchema, msg.data, 'INVALID_OUTPUT');
          stop({ ok: true, data: msg.data });
        } else if (msg.type === 'error') {
          const error = msg.error as PublicError | undefined;
          if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') throw new HarnessError('INVALID_OUTPUT', '插件错误格式无效。');
          const allowed = new Set(['PLUGIN_START_FAILED', 'PLUGIN_EXECUTION_FAILED', 'INVALID_OUTPUT', 'PERMISSION_DENIED', 'INVALID_PATH', 'INVALID_INPUT', 'FILE_NOT_FOUND', 'FILE_TOO_LARGE', 'INVALID_FILE', 'INVALID_ENCODING', 'FILE_READ_FAILED']);
          const code = allowed.has(error.code) ? error.code : 'PLUGIN_EXECUTION_FAILED';
          stop({ ok: false, error: { code, message: code.startsWith('PLUGIN_') ? '插件启动或执行失败；原始错误已隐藏。' : '插件数据或宿主文件读取请求无效。' } });
        } else if (msg.type === 'log') {
          accountLog(typeof msg.message === 'string' ? msg.message : '');
        } else if (msg.type === 'capability.request') {
          brokerCalls += 1;
          if (brokerCalls > 128) throw new HarnessError('OUTPUT_LIMIT', '宿主能力请求超过单次执行上限。');
          if (typeof msg.requestId !== 'string' || msg.method !== 'files.readText') throw new HarnessError('INVALID_OUTPUT', '不支持的宿主能力请求。');
          const requestId = msg.requestId;
          void (async () => {
            let reply: Record<string, unknown>;
            try { reply = { ok: true, data: await readGrantedText(record, msg.path, msg.maxBytes) }; }
            catch (error) { reply = { ok: false, error: publicError(error) }; }
            if (!outcome && !resolved && child.connected) child.send({ type: 'capability.response', requestId, ...reply }, () => {});
          })().catch(() => stop({ ok: false, error: { code: 'INTERNAL_ERROR', message: '宿主能力请求失败。' } }));
        } else throw new HarnessError('INVALID_OUTPUT', '未知插件协议消息。');
      } catch (error) { stop({ ok: false, error: publicError(error) }); }
    });
  });
}
