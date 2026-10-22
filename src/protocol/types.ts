export type JsonSchema = Record<string, unknown>;

export interface Capability {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  protocolVersion: '1.0';
  entry: string;
  capabilities: Capability[];
  configSchema: JsonSchema;
  permissions: Array<'files.read'>;
}

export interface PluginRecord {
  manifest: PluginManifest;
  enabled: boolean;
  config: Record<string, unknown>;
  grants: { readRoots: string[] };
  installedAt: string;
  packagePath: string;
}

export interface PluginRequest {
  capability: string;
  input: unknown;
  config: Record<string, unknown>;
}

export interface PluginContext {
  files: { readText(path: string, maxBytes?: number): Promise<{ text: string; bytes: number }> };
  log(message: string): void;
}

export type PluginExecute = (request: PluginRequest, context: PluginContext) => unknown | Promise<unknown>;
export interface PublicError { code: string; message: string }
export interface ExecutionResult {
  executionId: string;
  pluginId: string;
  capability: string;
  ok: boolean;
  durationMs: number;
  runtime?: { pid: number; terminated: boolean };
  data?: unknown;
  error?: PublicError;
}

/** A future model adapter receives tool descriptions and invokes the same host API.
 * No model implementation or deterministic imitation is provided by this project. */
export interface AgentAdapter {
  respond(task: string, tools: Capability[], invoke: (pluginId: string, capability: string, input: unknown) => Promise<ExecutionResult>): Promise<unknown>;
}
