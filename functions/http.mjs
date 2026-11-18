// HTTP 基础工具：固定来源校验、有界 JSON 读取、稳定错误码、响应头与访客元信息提取。
// 应用身份一律来自本应用自己的会话校验，绝不使用 ctx.user 或任何平台身份回退。
import { SITE_ORIGIN } from './config.mjs';

export const BODY_LIMIT_BYTES = 8192;
const NO_STORE = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' };

export class AppError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

// cookies 是 Set-Cookie 字符串数组；需要同时下发与清除 Cookie 时靠它，
// 而不是把多个值塞进一个 header（那会被合并成单个逗号串而失效）。
export function respond(value, status = 200, extra = {}, cookies = []) {
  const headers = new Headers({ ...NO_STORE, ...extra });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(value), { status, headers });
}

export function json(value, status = 200, extra = {}, cookies = []) {
  return respond(value, status, extra, cookies);
}

export function errorJson(code, status, extra = {}, cookies = []) {
  return respond({ error: code }, status, extra, cookies);
}

// 网关会把 app 段替换成部署的物理函数名，Provider 也可能先剥掉 /functions/v1。
export function applicationPath(request) {
  const match = new URL(request.url).pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
  if (!match) throw new AppError('not_found', 404);
  return match[1] || '/';
}

// 不安全方法必须来自固定来源（SameSite=Lax Cookie 之外的第二道 CSRF 防线）。
// 部署站点只接受配置的 HTTPS origin；额外的 loopback 例外仅用于本地演练，
// 生产配置永远不可能是 http://127.0.0.1，所以它不会放宽线上判定。
export function requireTrustedOrigin(request, origin = SITE_ORIGIN) {
  let configured;
  try { configured = new URL(origin); } catch { throw new AppError('application_auth_not_configured', 503); }
  const loopback = configured.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname);
  if ((configured.protocol !== 'https:' && !loopback) || configured.origin !== origin) {
    throw new AppError('application_auth_not_configured', 503);
  }
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  if (request.headers.get('origin') !== origin) throw new AppError('origin_forbidden', 403);
}

// 按实际流读取的字节数设上限，不信任 Content-Length。
export async function readJson(request, maxBytes = BODY_LIMIT_BYTES) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new AppError('invalid_input', 400);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('invalid_input', 400);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError('payload_too_large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AppError('invalid_input', 400);
  }
}

// 把数据层结果转换成业务结果：错误保留为稳定的应用错误码，不泄露 Provider 细节。
export function rows(result) {
  if (result?.error || !Array.isArray(result?.data)) throw new AppError('database_unavailable', 503);
  return result.data;
}

function bounded(value, max) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

// IPv4 保留前三段、IPv6 保留前三组：足够识别同一出口，又不留完整地址。
function coarseIp(raw) {
  const ip = bounded(raw, 64);
  if (!ip) return null;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0`;
  const v6 = ip.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
  if (v6) return `${v6[1]}:${v6[2]}:${v6[3]}::`;
  return null;
}

// 只取网关侧常见来源头；全部缺失时记为 unknown，不猜测、不接受浏览器自报。
export function clientMeta(request) {
  const headers = request.headers;
  const forwarded = headers.get('x-forwarded-for');
  const rawIp = (forwarded ? forwarded.split(',')[0].trim() : '')
    || headers.get('x-real-ip') || headers.get('cf-connecting-ip') || '';
  const fullIp = bounded(rawIp, 64);
  return {
    ip: coarseIp(fullIp),
    userAgent: bounded(headers.get('user-agent'), 200),
    rateKey: fullIp ? `ip:${fullIp}` : 'ip:unknown',
  };
}
