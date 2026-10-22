import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { PluginContext, PluginRequest } from '../protocol/types.js';

const MAX_BYTES = 1_048_576;
const pending = new Map<string, { resolve: (value: { text: string; bytes: number }) => void; reject: (error: Error) => void }>();
let invoked = false;

function send(value: unknown): void {
  if (process.connected) process.send?.(value);
}

process.on('disconnect', () => process.exit(1));
process.on('message', async (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  const msg = message as Record<string, unknown>;
  if (msg.type === 'capability.response' && typeof msg.requestId === 'string') {
    const request = pending.get(msg.requestId);
    if (!request) return;
    pending.delete(msg.requestId);
    if (msg.ok) request.resolve(msg.data as { text: string; bytes: number });
    else {
      const error = msg.error as { code: string; message: string };
      request.reject(Object.assign(new Error(error.message), { code: error.code }));
    }
    return;
  }
  if (msg.type !== 'invoke' || invoked) return;
  invoked = true;
  let execute: unknown;
  try {
    const module = await import(pathToFileURL(msg.entry as string).href) as { execute?: unknown };
    execute = module.execute;
    if (typeof execute !== 'function') throw new Error();
  } catch {
    send({ type: 'error', error: { code: 'PLUGIN_START_FAILED', message: '插件入口无法加载或未导出 execute 函数。' } });
    return;
  }
  const context: PluginContext = {
    files: {
      readText(file, maxBytes = MAX_BYTES) {
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          pending.set(requestId, { resolve, reject });
          send({ type: 'capability.request', requestId, method: 'files.readText', path: file, maxBytes });
        });
      }
    },
    log(message) { send({ type: 'log', message: String(message).slice(0, 4096) }); }
  };
  try {
    const data = await (execute as (request: PluginRequest, context: PluginContext) => unknown)(msg.request as PluginRequest, context);
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(data, (_key, value: unknown) => {
        if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) throw new Error();
        return value;
      });
      if (encoded === undefined || Buffer.byteLength(encoded) > MAX_BYTES) throw new Error();
    } catch {
      send({ type: 'error', error: { code: 'INVALID_OUTPUT', message: '插件结果必须是有限大小、可序列化的 JSON 数据。' } });
      return;
    }
    send({ type: 'result', data: JSON.parse(encoded) as unknown });
  } catch (error) {
    const brokerCodes = new Set(['PERMISSION_DENIED', 'INVALID_PATH', 'INVALID_INPUT', 'FILE_NOT_FOUND', 'FILE_TOO_LARGE', 'INVALID_FILE', 'INVALID_ENCODING', 'FILE_READ_FAILED']);
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && brokerCodes.has(error.code) ? error.code : 'PLUGIN_EXECUTION_FAILED';
    send({ type: 'error', error: { code, message: code === 'PLUGIN_EXECUTION_FAILED' ? '插件执行失败；原始异常信息已隐藏。' : '宿主文件读取请求被拒绝或无法完成。' } });
  }
});
