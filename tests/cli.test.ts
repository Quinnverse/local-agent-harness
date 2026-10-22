import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const PROJECT_ROOT = resolve(process.cwd());
const WORK_ROOT = join(PROJECT_ROOT, ".work");
const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const TEXT_PLUGIN = join(PROJECT_ROOT, "plugins", "text-transform");
const FILE_STATS_PLUGIN = join(PROJECT_ROOT, "plugins", "file-stats");

type JsonRecord = Record<string, unknown>;

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonOutput(stdout: string): JsonRecord {
  assert.ok(stdout.trim().length > 0, "CLI must write its JSON response to stdout");
  const parsed: unknown = JSON.parse(stdout);
  assert.ok(isRecord(parsed), "CLI JSON response must be an object");
  return parsed;
}

function runCli(dataDir: string, args: string[]): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(
      process.execPath,
      [CLI, "--data-dir", dataDir, ...args],
      { cwd: PROJECT_ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const candidate = error as (NodeJS.ErrnoException & { code?: string | number }) | null;
        resolveResult({
          exitCode: typeof candidate?.code === "number" ? candidate.code : error === null ? 0 : 1,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

async function expectCliSuccess(dataDir: string, args: string[]): Promise<JsonRecord> {
  const result = await runCli(dataDir, args);
  assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr || result.stdout}`);
  return parseJsonOutput(result.stdout);
}

test("CLI manages both official plugins and rejects a disabled execution with JSON", { timeout: 12_000 }, async (t) => {
  await mkdir(WORK_ROOT, { recursive: true });
  const dataDir = await mkdtemp(join(WORK_ROOT, "cli-test-"));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const fixtureDir = join(dataDir, "fixtures");
  const fixturePath = join(fixtureDir, "stats.txt");
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(fixturePath, "alpha beta\n你好世界\n", "utf8");

  const textInstalled = await expectCliSuccess(dataDir, ["plugins", "install", TEXT_PLUGIN]);
  assert.equal((textInstalled.manifest as JsonRecord).id, "demo.text-transform");
  await expectCliSuccess(dataDir, [
    "plugins", "configure", "demo.text-transform", "--config-json", JSON.stringify({ caseMode: "lower" }),
  ]);
  await expectCliSuccess(dataDir, ["plugins", "enable", "demo.text-transform"]);
  const textRun = await expectCliSuccess(dataDir, [
    "plugins", "run", "demo.text-transform", "--capability", "text.transform", "--input-json", JSON.stringify({ text: "CLI MiXeD" }),
  ]);
  assert.equal(textRun.ok, true);
  assert.deepEqual(textRun.data, { text: "cli mixed" });

  const statsInstalled = await expectCliSuccess(dataDir, ["plugins", "install", FILE_STATS_PLUGIN]);
  assert.equal((statsInstalled.manifest as JsonRecord).id, "demo.file-stats");
  await expectCliSuccess(dataDir, [
    "plugins", "configure", "demo.file-stats", "--config-json", JSON.stringify({ maxBytes: 64 }),
  ]);
  await expectCliSuccess(dataDir, ["permissions", "grant", "demo.file-stats", "--read-root", fixtureDir]);
  await expectCliSuccess(dataDir, ["plugins", "enable", "demo.file-stats"]);
  const statsRun = await expectCliSuccess(dataDir, [
    "plugins", "run", "demo.file-stats", "--capability", "file.stats", "--input-json", JSON.stringify({ path: fixturePath }),
  ]);
  assert.equal(statsRun.ok, true);
  assert.deepEqual(statsRun.data, { bytes: 24, lines: 2, tokens: 3 });

  await expectCliSuccess(dataDir, ["plugins", "disable", "demo.text-transform"]);
  const disabled = await runCli(dataDir, [
    "plugins", "run", "demo.text-transform", "--capability", "text.transform", "--input-json", JSON.stringify({ text: "must fail" }),
  ]);
  assert.notEqual(disabled.exitCode, 0, "disabled execution must produce a non-zero CLI exit status");
  const failedRun = parseJsonOutput(disabled.stdout);
  assert.equal(failedRun.ok, false);
  assert.ok(isRecord(failedRun.error));
  assert.equal(typeof failedRun.error.code, "string");
  assert.ok((failedRun.error.code as string).length > 0);
});
