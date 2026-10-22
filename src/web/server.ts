import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Harness } from '../core/harness.js';
import { HarnessError, publicError } from '../core/errors.js';

const MAX_BODY_BYTES = 1024 * 1024;
const staticDirectory = path.dirname(fileURLToPath(import.meta.url));

const STATIC_FILES: ReadonlyMap<string, { readonly file: string; readonly contentType: string }> = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', contentType: 'application/javascript; charset=utf-8' }],
  ['/style.css', { file: 'style.css', contentType: 'text/css; charset=utf-8' }],
  ['/manus-routes.json', { file: 'manus-routes.json', contentType: 'application/json; charset=utf-8' }],
]);

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export interface StartedServer {
  server: Server;
  url: string;
  token: string;
}

/** Starts the local-only management API.  The caller owns server.close(). */
export async function startServer(
  harness: Harness,
  options: { port?: number } = {},
): Promise<StartedServer> {
  const port = options.port ?? 4317;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('port 必须是 0..65535 的整数。');
  }

  const token = randomBytes(32).toString('hex');
  let origin = '';
  let authority = '';

  const server = createServer((request, response) => {
    void handleRequest(request, response, harness, token, () => origin, () => authority)
      .catch(error => handlePublicError(response, error));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error('Loopback server did not provide a TCP address.');
  }
  authority = `127.0.0.1:${address.port}`;
  origin = `http://${authority}`;
  return { server, url: origin, token };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  harness: Harness,
  token: string,
  getOrigin: () => string,
  getAuthority: () => string,
): Promise<void> {
  const method = request.method ?? 'GET';
  const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

  if (request.headers.host !== getAuthority()) {
    sendError(response, 400, 'INVALID_HOST', 'Host 必须是本地服务的精确地址。');
    request.resume();
    return;
  }
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined && requestOrigin !== getOrigin()) {
    sendError(response, 403, 'INVALID_ORIGIN', 'Origin 必须与本地服务地址一致。');
    request.resume();
    return;
  }
  if (isWrite) {
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', '写入请求必须使用 Content-Type: application/json。');
      request.resume();
      return;
    }
    if (request.headers['x-harness-token'] !== token) {
      sendError(response, 403, 'INVALID_TOKEN', '缺少或无效的本地会话令牌。');
      request.resume();
      return;
    }
  }

  let url: URL;
  try {
    url = new URL(request.url ?? '/', getOrigin());
  } catch {
    throw new RequestError(400, 'INVALID_REQUEST', '请求路径无效。');
  }

  if (method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === 'GET' && url.pathname === '/api/session') {
    sendOk(response, { token, dataDir: harness.dataDir, protocolVersion: '1.0' });
    return;
  }
  if (method === 'GET' && url.pathname === '/api/plugins') {
    sendOk(response, await harness.list());
    return;
  }
  if (method === 'POST' && url.pathname === '/api/plugins') {
    const body = requireObject(await readJsonBody(request));
    const source = body.source;
    if (typeof source !== 'string') throw invalidRequest('source 必须是字符串。');
    sendOk(response, await harness.install(source));
    return;
  }

  const pluginRoute = parsePluginRoute(url.pathname);
  if (pluginRoute !== null) {
    await handlePluginRoute(method, pluginRoute.id, pluginRoute.action, request, response, harness);
    return;
  }

  if (method === 'GET') {
    const staticFile = STATIC_FILES.get(url.pathname);
    if (staticFile !== undefined) {
      await serveStatic(response, staticFile);
      return;
    }
  }

  throw new RequestError(404, 'NOT_FOUND', '请求的本地资源不存在。');
}

function parsePluginRoute(pathname: string): { id: string; action: 'record' | 'config' | 'enable' | 'disable' | 'grants' | 'run' } | null {
  const match = /^\/api\/plugins\/([^/]+)(?:\/(config|enable|disable|grants|run))?$/.exec(pathname);
  if (match === null) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    throw new RequestError(400, 'INVALID_REQUEST', '插件 ID 编码无效。');
  }
  const action = match[2] as 'config' | 'enable' | 'disable' | 'grants' | 'run' | undefined;
  return { id, action: action ?? 'record' };
}

async function handlePluginRoute(
  method: string,
  id: string,
  action: 'record' | 'config' | 'enable' | 'disable' | 'grants' | 'run',
  request: IncomingMessage,
  response: ServerResponse,
  harness: Harness,
): Promise<void> {
  if (method === 'GET' && action === 'record') {
    sendOk(response, await harness.show(id));
    return;
  }

  if (method === 'POST' && action === 'record') {
    const body = requireObject(await readJsonBody(request));
    const source = body.source;
    if (typeof source !== 'string') throw invalidRequest('source 必须是字符串。');
    sendOk(response, await harness.install(source));
    return;
  }

  if (method === 'PUT' && action === 'config') {
    const body = requireObject(await readJsonBody(request));
    sendOk(response, await harness.configure(id, requireObject(body.config, 'config')));
    return;
  }

  if (method === 'POST' && (action === 'enable' || action === 'disable')) {
    requireObject(await readJsonBody(request));
    sendOk(response, action === 'enable' ? await harness.enable(id) : await harness.disable(id));
    return;
  }

  if (method === 'POST' && action === 'grants') {
    const body = requireObject(await readJsonBody(request));
    if (typeof body.root !== 'string') throw invalidRequest('root 必须是字符串。');
    sendOk(response, await harness.grant(id, body.root));
    return;
  }

  if (method === 'DELETE' && action === 'grants') {
    const body = requireObject(await readJsonBody(request));
    if (typeof body.root !== 'string') throw invalidRequest('root 必须是字符串。');
    sendOk(response, await harness.revoke(id, body.root));
    return;
  }

  if (method === 'POST' && action === 'run') {
    const body = requireObject(await readJsonBody(request));
    if (typeof body.capability !== 'string') throw invalidRequest('capability 必须是字符串。');
    const timeoutMs = body.timeoutMs;
    if (timeoutMs !== undefined && typeof timeoutMs !== 'number') throw invalidRequest('timeoutMs 必须是数字。');
    sendOk(response, await harness.run(id, body.capability, body.input, { timeoutMs }));
    return;
  }

  throw new RequestError(404, 'NOT_FOUND', '请求的本地资源不存在。');
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers['content-length'];
  if (typeof declaredLength === 'string' && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_BODY_BYTES) {
    request.resume();
    throw new RequestError(413, 'BODY_TOO_LARGE', 'JSON 请求正文不能超过 1 MiB。');
  }

  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    });
    request.once('end', () => {
      if (tooLarge) reject(new RequestError(413, 'BODY_TOO_LARGE', 'JSON 请求正文不能超过 1 MiB。'));
      else resolve(Buffer.concat(chunks));
    });
    request.once('aborted', () => reject(new RequestError(400, 'INVALID_REQUEST', '请求在接收完成前中断。')));
    request.once('error', () => reject(new RequestError(400, 'INVALID_REQUEST', '无法读取请求正文。')));
  });

  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new RequestError(400, 'INVALID_JSON', '请求正文必须是有效 JSON。');
  }
}

function requireObject(value: unknown, name = '请求正文'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRequest(`${name} 必须是 JSON 对象。`);
  }
  return value as Record<string, unknown>;
}

function invalidRequest(message: string): RequestError {
  return new RequestError(400, 'INVALID_REQUEST', message);
}

async function serveStatic(
  response: ServerResponse,
  staticFile: { readonly file: string; readonly contentType: string },
): Promise<void> {
  try {
    const contents = await readFile(path.join(staticDirectory, staticFile.file));
    setSecurityHeaders(response);
    response.writeHead(200, { 'Content-Type': staticFile.contentType, 'Content-Length': contents.length });
    response.end(contents);
  } catch (error) {
    if (isMissingFile(error)) throw new RequestError(404, 'NOT_FOUND', '请求的本地资源不存在。');
    throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function sendOk(response: ServerResponse, data: unknown): void {
  sendJson(response, 200, { ok: true, data });
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.writableEnded) return;
  sendJson(response, status, { ok: false, error: { code, message } });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const contents = JSON.stringify(payload);
  setSecurityHeaders(response);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(contents),
  });
  response.end(contents);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
}

function statusForError(error: unknown): number {
  if (error instanceof RequestError) return error.status;
  if (error instanceof HarnessError) {
    if (error.code === 'PLUGIN_NOT_FOUND') return 404;
    if (error.code === 'DUPLICATE_PLUGIN_ID') return 409;
    return 400;
  }
  return 500;
}

// Convert all failures that cross the HTTP boundary to the public error format.
async function handlePublicError(response: ServerResponse, error: unknown): Promise<void> {
  if (error instanceof RequestError) {
    sendError(response, error.status, error.code, error.message);
    return;
  }
  const publicFailure = publicError(error);
  sendError(response, statusForError(error), publicFailure.code, publicFailure.message);
}
