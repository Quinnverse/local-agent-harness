import { Ajv } from 'ajv';
import type { JsonSchema, PluginManifest } from './types.js';
import { HarnessError } from '../core/errors.js';

export const PROTOCOL_VERSION = '1.0';
export const MAX_MESSAGE_BYTES = 1_048_576;
const ajv = new Ajv({ strict: true, allErrors: true });
const defaultsAjv = new Ajv({ strict: true, allErrors: true, useDefaults: true });
const manifestValidator = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'version', 'protocolVersion', 'entry', 'capabilities', 'configSchema', 'permissions'],
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$', maxLength: 100 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', maxLength: 1000 },
    version: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$' },
    protocolVersion: { type: 'string', minLength: 1 },
    entry: { type: 'string', minLength: 1, maxLength: 256 },
    capabilities: {
      type: 'array', minItems: 1, maxItems: 32,
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'inputSchema', 'outputSchema'],
        properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9.-]*$', maxLength: 100 },
          description: { type: 'string', maxLength: 1000 },
          inputSchema: { type: 'object' }, outputSchema: { type: 'object' }
        }
      }
    },
    configSchema: { type: 'object' },
    permissions: { type: 'array', uniqueItems: true, items: { enum: ['files.read'] }, maxItems: 1 }
  }
});

export function validateManifest(value: unknown): PluginManifest {
  if (!manifestValidator(value)) throw new HarnessError('INVALID_MANIFEST', 'manifest 结构无效，请检查必填字段和字段类型。');
  const manifest = value as PluginManifest;
  if (manifest.protocolVersion !== PROTOCOL_VERSION) throw new HarnessError('PROTOCOL_UNSUPPORTED', '宿主仅支持插件协议 1.0。');
  if (manifest.configSchema.type !== 'object') throw new HarnessError('INVALID_MANIFEST', 'configSchema 必须定义 object。');
  if (new Set(manifest.capabilities.map(c => c.name)).size !== manifest.capabilities.length) {
    throw new HarnessError('INVALID_MANIFEST', '能力名不能重复。');
  }
  try {
    defaultsAjv.compile(manifest.configSchema);
    for (const capability of manifest.capabilities) {
      ajv.compile(capability.inputSchema);
      ajv.compile(capability.outputSchema);
    }
  } catch {
    throw new HarnessError('INVALID_MANIFEST', '插件包含不支持或无效的 JSON Schema。');
  }
  return structuredClone(manifest);
}

export function validateData(schema: JsonSchema, value: unknown, code: string): void {
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(value) ?? ''); }
  catch { throw new HarnessError(code, '数据必须可序列化为 JSON。'); }
  if (size > MAX_MESSAGE_BYTES) throw new HarnessError(code, '数据超过 1 MiB 上限。');
  if (!ajv.compile(schema)(value)) throw new HarnessError(code, '数据不符合插件声明的 JSON Schema。');
}

export function effectiveConfig(schema: JsonSchema, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HarnessError('INVALID_CONFIG', '配置必须是 JSON 对象。');
  const copy = structuredClone(value) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(copy)) > 65_536) throw new HarnessError('INVALID_CONFIG', '配置超过 64 KiB 上限。');
  if (!defaultsAjv.compile(schema)(copy)) throw new HarnessError('INVALID_CONFIG', '配置无效；原配置保持不变。');
  return copy;
}
