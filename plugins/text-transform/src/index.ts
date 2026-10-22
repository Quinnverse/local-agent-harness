import type { PluginRequest } from '../../../src/sdk/index.js';

export async function execute(request: PluginRequest): Promise<{ text: string }> {
  const { text } = request.input as { text: string };
  return { text: request.config.caseMode === 'lower' ? text.toLowerCase() : text.toUpperCase() };
}
