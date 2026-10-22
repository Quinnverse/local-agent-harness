#!/usr/bin/env node
import { Command } from 'commander';
import { Harness } from './core/harness.js';
import { HarnessError, publicError } from './core/errors.js';

const program = new Command();
program.name('harness').description('本地可扩展 Agent 工具宿主（不伪装模型推理）').version('1.0.0').option('--data-dir <directory>', '独立用户数据目录');
const host = () => new Harness({ dataDir: program.opts<{ dataDir?: string }>().dataDir });
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const parse = (value: string): unknown => {
  try { return JSON.parse(value) as unknown; }
  catch { throw new HarnessError('INVALID_JSON', '参数必须是合法 JSON。'); }
};
const plugins = program.command('plugins').description('安装和管理本地插件');
plugins.command('install <directory>').action(async directory => output(await host().install(directory)));
plugins.command('list').action(async () => output(await host().list()));
plugins.command('show <id>').action(async id => output(await host().show(id)));
plugins.command('configure <id>').requiredOption('--config-json <json>', '完整配置 JSON；缺失字段应用默认值').action(async (id, options: { configJson: string }) => output(await host().configure(id, parse(options.configJson) as Record<string, unknown>)));
plugins.command('enable <id>').action(async id => output(await host().enable(id)));
plugins.command('disable <id>').action(async id => output(await host().disable(id)));
plugins.command('run <id>').requiredOption('--capability <name>', '插件能力名').requiredOption('--input-json <json>', '输入 JSON').option('--timeout-ms <number>', '执行超时毫秒', '5000').action(async (id, options: { capability: string; inputJson: string; timeoutMs: string }) => {
  const result = await host().run(id, options.capability, parse(options.inputJson), { timeoutMs: Number(options.timeoutMs) });
  output(result);
  if (!result.ok) process.exitCode = 1;
});
const permissions = program.command('permissions').description('授权仅约束宿主提供的文件 broker，不是 OS 沙箱');
permissions.command('grant <id>').requiredOption('--read-root <directory>', '允许读取的目录').action(async (id, options: { readRoot: string }) => output(await host().grant(id, options.readRoot)));
permissions.command('revoke <id>').requiredOption('--read-root <directory>', '撤销目录授权').action(async (id, options: { readRoot: string }) => output(await host().revoke(id, options.readRoot)));
program.command('serve').description('启动仅绑定127.0.0.1的本地Web管理').option('--port <number>', '本地端口', '4317').action(async (options: { port: string }) => {
  // The UI is implemented only after the core acceptance gate passes.
  const modulePath = './web/server.js';
  const { startServer } = await import(modulePath) as { startServer: (harness: Harness, options: { port: number }) => Promise<{ server: import('node:http').Server; url: string }> };
  const { server, url } = await startServer(host(), { port: Number(options.port) });
  output({ url, dataDir: host().dataDir, security: '可信插件模型；子进程不是完整安全沙箱' });
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close); process.once('SIGTERM', close);
});
try { await program.parseAsync(process.argv); }
catch (error) { output({ ok: false, error: publicError(error) }); process.exitCode = 1; }
