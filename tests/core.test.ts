import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { Harness } from "../src/core/harness.js";

const PROJECT_ROOT = resolve(process.cwd());
const WORK_ROOT = join(PROJECT_ROOT, ".work");
const TEXT_PLUGIN = join(PROJECT_ROOT, "plugins", "text-transform");
const FILE_STATS_PLUGIN = join(PROJECT_ROOT, "plugins", "file-stats");

type JsonRecord = Record<string, unknown>;

type PluginOptions = {
  id: string;
  capability?: string;
  permissions?: string[];
  configSchema?: JsonRecord;
  capabilities?: unknown[];
  entrySource?: string;
  writeEntry?: boolean;
  manifestPatch?: JsonRecord;
  replacementManifest?: JsonRecord;
  directoryName?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

function assertExecutionSucceeded(value: unknown): JsonRecord {
  const result = requireRecord(value, "execution result");
  assert.equal(result.ok, true, `expected successful execution, got ${JSON.stringify(result)}`);
  return result;
}

function assertExecutionFailed(value: unknown): JsonRecord {
  const result = requireRecord(value, "execution result");
  assert.equal(result.ok, false, `expected failed execution, got ${JSON.stringify(result)}`);
  const error = requireRecord(result.error, "execution error");
  assert.equal(typeof error.code, "string");
  assert.ok((error.code as string).length > 0, "execution errors must carry a code");
  assert.equal(typeof error.message, "string");
  assert.ok((error.message as string).length > 0, "execution errors must carry a message");
  return result;
}

async function expectManagementError(operation: () => Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    if (!isRecord(error)) {
      return false;
    }
    return typeof error.code === "string" && error.code.length > 0 && typeof error.message === "string";
  });
}

function isolated(name: string, body: (dataDir: string) => Promise<void>): void {
  test(name, { timeout: 8_000 }, async (t) => {
    await mkdir(WORK_ROOT, { recursive: true });
    const dataDir = await mkdtemp(join(WORK_ROOT, "core-test-"));
    t.after(async () => {
      await rm(dataDir, { recursive: true, force: true });
    });
    await body(dataDir);
  });
}

async function writePlugin(root: string, options: PluginOptions): Promise<string> {
  const directory = join(root, options.directoryName ?? `plugin-${options.id.replace(/[^a-z0-9]/giu, "-")}`);
  await mkdir(directory, { recursive: true });

  const capability = options.capability ?? "test.echo";
  const manifest: JsonRecord = options.replacementManifest ?? {
    id: options.id,
    name: options.id,
    version: "1.0.0",
    protocolVersion: "1.0",
    entry: "./entry.js",
    capabilities: options.capabilities ?? [
      {
        name: capability,
        inputSchema: {
          type: "object",
          required: ["value"],
          additionalProperties: false,
          properties: { value: { type: "string" } },
        },
        outputSchema: {
          type: "object",
          required: ["value"],
          additionalProperties: false,
          properties: { value: { type: "string" } },
        },
      },
    ],
    configSchema: options.configSchema ?? {
      type: "object",
      additionalProperties: false,
      properties: { prefix: { type: "string", default: "" } },
    },
    permissions: options.permissions ?? [],
    ...options.manifestPatch,
  };

  await writeFile(join(directory, "package.json"), `${JSON.stringify({ type: "module" })}\n`, "utf8");
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  if (options.writeEntry !== false) {
    const entry = options.entrySource ?? [
      "export async function execute(request) {",
      "  return { value: `${request.config.prefix ?? \"\"}${request.input.value}` };",
      "}",
      "",
    ].join("\n");
    await writeFile(join(directory, "entry.js"), entry, "utf8");
  }
  return directory;
}

isolated("core installs, configures, enables, and executes both official plugins with real output", async (dataDir) => {
  const harness = new Harness({ dataDir });
  const fixtureDir = join(dataDir, "fixtures");
  const fixturePath = join(fixtureDir, "stats.txt");
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(fixturePath, "alpha beta\n你好世界\n", "utf8");

  const textRecord = await harness.install(TEXT_PLUGIN);
  assert.equal(textRecord.manifest.id, "demo.text-transform");
  assert.equal(textRecord.enabled, false);
  await harness.configure("demo.text-transform", { caseMode: "lower" });
  await harness.enable("demo.text-transform");
  const textRun = assertExecutionSucceeded(await harness.run(
    "demo.text-transform",
    "text.transform",
    { text: "MiXeD 中文" },
  ));
  assert.deepEqual(textRun.data, { text: "mixed 中文" });

  const statsRecord = await harness.install(FILE_STATS_PLUGIN);
  assert.equal(statsRecord.manifest.id, "demo.file-stats");
  await harness.configure("demo.file-stats", { maxBytes: 64 });
  await harness.grant("demo.file-stats", fixtureDir);
  await harness.enable("demo.file-stats");
  const statsRun = assertExecutionSucceeded(await harness.run(
    "demo.file-stats",
    "file.stats",
    { path: fixturePath },
  ));
  assert.deepEqual(statsRun.data, { bytes: 24, lines: 2, tokens: 3 });
});

isolated("core refuses a newly disabled plugin with a structured execution error", async (dataDir) => {
  const harness = new Harness({ dataDir });
  await harness.install(TEXT_PLUGIN);
  await harness.configure("demo.text-transform", { caseMode: "upper" });
  await harness.enable("demo.text-transform");
  await harness.disable("demo.text-transform");

  assertExecutionFailed(await harness.run(
    "demo.text-transform",
    "text.transform",
    { text: "must not execute" },
  ));
});

isolated("core state survives a Harness restart", async (dataDir) => {
  const initial = new Harness({ dataDir });
  await initial.install(TEXT_PLUGIN);
  await initial.configure("demo.text-transform", { caseMode: "lower" });
  await initial.enable("demo.text-transform");

  const restarted = new Harness({ dataDir });
  const restored = await restarted.show("demo.text-transform");
  assert.equal(restored.enabled, true);
  assert.deepEqual(restored.config, { caseMode: "lower" });
  const run = assertExecutionSucceeded(await restarted.run(
    "demo.text-transform",
    "text.transform",
    { text: "ReStArTeD" },
  ));
  assert.deepEqual(run.data, { text: "restarted" });
});

isolated("core rejects unsafe packages and leaves the last valid configuration intact", async (dataDir) => {
  const harness = new Harness({ dataDir });

  const invalidManifest = await writePlugin(dataDir, {
    id: "test.invalid-manifest",
    directoryName: "invalid-manifest",
    replacementManifest: { id: "test.invalid-manifest" },
  });
  await expectManagementError(() => harness.install(invalidManifest));

  const duplicate = await writePlugin(dataDir, { id: "test.duplicate", directoryName: "duplicate" });
  await harness.install(duplicate);
  await expectManagementError(() => harness.install(duplicate));

  const escapedEntry = await writePlugin(dataDir, {
    id: "test.escaped-entry",
    directoryName: "escaped-entry",
    manifestPatch: { entry: "../outside.js" },
  });
  await expectManagementError(() => harness.install(escapedEntry));

  const missingEntry = await writePlugin(dataDir, {
    id: "test.missing-entry",
    directoryName: "missing-entry",
    manifestPatch: { entry: "./does-not-exist.js" },
    writeEntry: false,
  });
  await expectManagementError(() => harness.install(missingEntry));

  const incompatibleProtocol = await writePlugin(dataDir, {
    id: "test.bad-protocol",
    directoryName: "bad-protocol",
    manifestPatch: { protocolVersion: "2.0" },
  });
  await expectManagementError(() => harness.install(incompatibleProtocol));

  const configurable = await writePlugin(dataDir, {
    id: "test.config-safety",
    directoryName: "config-safety",
    configSchema: {
      type: "object",
      required: ["mode"],
      additionalProperties: false,
      properties: { mode: { type: "string", enum: ["upper", "lower"], default: "upper" } },
    },
  });
  await harness.install(configurable);
  await harness.configure("test.config-safety", { mode: "lower" });
  await expectManagementError(() => harness.configure("test.config-safety", { mode: "sideways" }));
  assert.deepEqual((await harness.show("test.config-safety")).config, { mode: "lower" });
});

isolated("file broker enforces grants, real paths, UTF-8, and configured byte limits", async (dataDir) => {
  const harness = new Harness({ dataDir });
  const permittedRoot = join(dataDir, "permitted");
  const outsideRoot = join(dataDir, "outside");
  await mkdir(permittedRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });

  const brokerPlugin = await writePlugin(dataDir, {
    id: "test.broker",
    directoryName: "broker-plugin",
    capability: "test.read-file",
    permissions: ["files.read"],
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: { maxBytes: { type: "integer", minimum: 1, maximum: 1024, default: 64 } },
    },
    capabilities: [
      {
        name: "test.read-file",
        inputSchema: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: { path: { type: "string" } },
        },
        outputSchema: {
          type: "object",
          required: ["text", "bytes"],
          additionalProperties: false,
          properties: { text: { type: "string" }, bytes: { type: "integer" } },
        },
      },
    ],
    entrySource: [
      "export async function execute(request, context) {",
      "  return context.files.readText(request.input.path, request.config.maxBytes);",
      "}",
      "",
    ].join("\n"),
  });

  const allowed = join(permittedRoot, "allowed.txt");
  await writeFile(allowed, "allowed text", "utf8");
  await harness.install(brokerPlugin);
  await harness.configure("test.broker", { maxBytes: 64 });
  await harness.enable("test.broker");

  assertExecutionFailed(await harness.run("test.broker", "test.read-file", { path: allowed }));

  await harness.grant("test.broker", permittedRoot);
  const allowedRead = assertExecutionSucceeded(await harness.run(
    "test.broker",
    "test.read-file",
    { path: allowed },
  ));
  assert.deepEqual(allowedRead.data, { text: "allowed text", bytes: 12 });

  const outside = join(outsideRoot, "secret.txt");
  const link = join(permittedRoot, "outside-link.txt");
  await writeFile(outside, "not authorized", "utf8");
  await symlink(outside, link);
  assertExecutionFailed(await harness.run("test.broker", "test.read-file", { path: link }));

  const tooLarge = join(permittedRoot, "too-large.txt");
  await writeFile(tooLarge, "x".repeat(32), "utf8");
  await harness.configure("test.broker", { maxBytes: 8 });
  assertExecutionFailed(await harness.run("test.broker", "test.read-file", { path: tooLarge }));

  const invalidUtf8 = join(permittedRoot, "invalid-utf8.bin");
  await writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]));
  await harness.configure("test.broker", { maxBytes: 64 });
  assertExecutionFailed(await harness.run("test.broker", "test.read-file", { path: invalidUtf8 }));
});

isolated("plugin exception, crash, load failure, invalid output, and timeout return error envelopes", async (dataDir) => {
  const harness = new Harness({ dataDir, timeoutMs: 250 });
  const exception = await writePlugin(dataDir, {
    id: "test.exception",
    directoryName: "exception",
    entrySource: "export async function execute() { throw new Error('intentional plugin exception'); }\n",
  });
  const crash = await writePlugin(dataDir, {
    id: "test.crash",
    directoryName: "crash",
    entrySource: "export async function execute() { process.exit(17); }\n",
  });
  const loadFailure = await writePlugin(dataDir, {
    id: "test.load-failure",
    directoryName: "load-failure",
    entrySource: "import './absent-dependency.js';\nexport async function execute() { return { value: 'never' }; }\n",
  });
  const badOutput = await writePlugin(dataDir, {
    id: "test.bad-output",
    directoryName: "bad-output",
    entrySource: "export async function execute() { return { unexpected: true }; }\n",
  });
  const timeout = await writePlugin(dataDir, {
    id: "test.timeout",
    directoryName: "timeout",
    entrySource: [
      "process.on('SIGTERM', () => {});",
      "export async function execute() {",
      "  await new Promise(() => {});",
      "  return { value: 'never' };",
      "}",
      "",
    ].join("\n"),
  });

  for (const [id, source] of [
    ["test.exception", exception],
    ["test.crash", crash],
    ["test.load-failure", loadFailure],
    ["test.bad-output", badOutput],
    ["test.timeout", timeout],
  ] as const) {
    await harness.install(source);
    await harness.enable(id);
  }

  for (const id of ["test.exception", "test.crash", "test.load-failure", "test.bad-output"]) {
    assertExecutionFailed(await harness.run(id, "test.echo", { value: "input" }));
  }

  const timedOut = assertExecutionFailed(await harness.run(
    "test.timeout",
    "test.echo",
    { value: "input" },
    { timeoutMs: 250 },
  ));
  const runtime = requireRecord(timedOut.runtime, "timeout runtime metadata");
  assert.equal(typeof runtime.pid, "number");
  assert.ok((runtime.pid as number) > 0);
  assert.equal(runtime.terminated, true);
  const pid = runtime.pid as number;
  assert.throws(() => process.kill(pid, 0), (error: unknown) => isRecord(error) && error.code === "ESRCH");
});

isolated("a third plugin can be created, installed, and executed without host changes", async (dataDir) => {
  const harness = new Harness({ dataDir });
  const thirdPlugin = await writePlugin(dataDir, {
    id: "test.dynamic-third-plugin",
    directoryName: "dynamic-third-plugin",
    capability: "third.reverse",
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: { separator: { type: "string", default: ":" } },
    },
    entrySource: [
      "export async function execute(request) {",
      "  return { value: request.input.value.split('').reverse().join('') + request.config.separator + 'third' };",
      "}",
      "",
    ].join("\n"),
  });

  await harness.install(thirdPlugin);
  await harness.configure("test.dynamic-third-plugin", { separator: "|" });
  await harness.enable("test.dynamic-third-plugin");
  const result = assertExecutionSucceeded(await harness.run(
    "test.dynamic-third-plugin",
    "third.reverse",
    { value: "agent" },
  ));
  assert.deepEqual(result.data, { value: "tnega|third" });
});

isolated("concurrent complete configuration writes leave a readable, valid registry", async (dataDir) => {
  const first = new Harness({ dataDir });
  const concurrentPlugin = await writePlugin(dataDir, {
    id: "test.concurrent-config",
    directoryName: "concurrent-config",
  });
  await first.install(concurrentPlugin);
  const second = new Harness({ dataDir });

  const values = Array.from({ length: 20 }, (_, index) => `value-${index}`);
  await Promise.all(values.map((prefix, index) => {
    const harness = index % 2 === 0 ? first : second;
    return harness.configure("test.concurrent-config", { prefix });
  }));

  const reloaded = new Harness({ dataDir });
  const record = await reloaded.show("test.concurrent-config");
  assert.ok(values.includes(record.config.prefix as string));
  const listed = await reloaded.list();
  assert.equal(listed.filter((item) => item.manifest.id === "test.concurrent-config").length, 1);
});
