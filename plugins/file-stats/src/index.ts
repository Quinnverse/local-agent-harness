import type { PluginRequest, PluginContext } from '../../../src/sdk/index.js';

export async function execute(request: PluginRequest, context: PluginContext): Promise<{ bytes: number; lines: number; tokens: number }> {
  const { path } = request.input as { path: string };
  const { text, bytes } = await context.files.readText(path, request.config.maxBytes as number);
  const segments = text.split(/\r\n|\n|\r/u);
  const lines = text.length === 0 ? 0 : segments.length - (/(?:\r\n|\n|\r)$/u.test(text) ? 1 : 0);
  const tokens = text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length;
  return { bytes, lines, tokens };
}
