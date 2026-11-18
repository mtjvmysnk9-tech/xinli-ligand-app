// 会话：32 字节随机不透明令牌放在 __Host- Cookie 中；数据库只保存令牌的 SHA-256 摘要、
// 归属与时间。明文令牌从不落库、从不记录、从不回显。
// 账号会话与管理员会话共用 sessions 表（管理员只是 users.role='admin' 的一行），
// 靠不同 Cookie 名区分用途；游客会话单独一张表，不关联任何账号。
import { AppError, rows } from './http.mjs';
import { ADMIN_COOKIE, GUEST_COOKIE, GUEST_TTL_MS, SESSION_COOKIE, SESSION_TTL_MS } from './config.mjs';

const TOKEN_BYTES = 32;
const MAX_COOKIE_HEADER = 8192;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function newToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function cookieHeader(name, token, maxAgeSeconds) {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export const sessionCookie = (token) => cookieHeader(SESSION_COOKIE, token, Math.floor(SESSION_TTL_MS / 1000));
export const adminCookie = (token) => cookieHeader(ADMIN_COOKIE, token, Math.floor(SESSION_TTL_MS / 1000));
export const guestCookie = (token) => cookieHeader(GUEST_COOKIE, token, Math.floor(GUEST_TTL_MS / 1000));

// 只读取指定名称的 Cookie；重复或超长一律视为无效，不猜测、不回退。
export function readToken(request, name) {
  const header = request.headers.get('cookie') ?? '';
  if (!header) return null;
  if (header.length > MAX_COOKIE_HEADER) throw new AppError('invalid_credentials', 400);
  const values = [];
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    if (trimmed.slice(0, at).trim() === name) values.push(trimmed.slice(at + 1));
  }
  if (values.length === 0) return null;
  if (values.length > 1) throw new AppError('invalid_credentials', 400);
  if (!TOKEN_PATTERN.test(values[0])) throw new AppError('invalid_credentials', 400);
  return values[0];
}

// 「插入或忽略」后必须核对回执行数：0 行代表唯一键已存在，抛异常代表结果未知，
// 两者都绝不重放——宁可让这次登录失败，也不能覆盖或重复别人的会话。
async function insertUnique(db, table, row, onConflict, columns) {
  let created;
  try {
    created = rows(await db.from(table).insertIfAbsent(row, { onConflict }).select(columns));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('session_unavailable', 503);
  }
  if (created.length !== 1) throw new AppError('session_unavailable', 503);
  return created;
}

export async function createSession(db, userId, now = Date.now()) {
  const token = newToken();
  const digest = await sha256Hex(token);
  await insertUnique(db, 'sessions', {
    token_digest: digest,
    user_id: userId,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
  }, 'token_digest', 'token_digest');
  return { token, digest };
}

// 每个请求都重新校验：Cookie 存在 → 摘要查库 → 未撤销且未过期才算通过。
// 返回 { state, session }，state 取值 missing | invalid | valid。
export async function validateSession(db, request, name, now = Date.now()) {
  const token = readToken(request, name);
  if (!token) return { state: 'missing', session: null };
  const digest = await sha256Hex(token);
  const found = rows(await db.from('sessions')
    .select('token_digest,user_id,expires_at,revoked_at').eq('token_digest', digest).limit(1));
  if (found.length !== 1) return { state: 'invalid', session: null };
  const row = found[0];
  if (row.token_digest !== digest || typeof row.user_id !== 'string') return { state: 'invalid', session: null };
  if (row.revoked_at != null) return { state: 'invalid', session: null };
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { state: 'invalid', session: null };
  return { state: 'valid', session: { digest, userId: row.user_id, expiresAt } };
}

// 先撤销数据库中的会话，再由调用方清除 Cookie。
// 谓词只用主键摘要；重复撤销是幂等的（同一个值再写一次）。
export async function revokeSession(db, digest, now = Date.now()) {
  const revoked = rows(await db.from('sessions')
    .update({ revoked_at: new Date(now).toISOString() }).eq('token_digest', digest).select('token_digest'));
  return revoked.length === 1;
}

export async function createGuestSession(db, now = Date.now()) {
  const token = newToken();
  const digest = await sha256Hex(token);
  await insertUnique(db, 'guests', {
    id: crypto.randomUUID(),
    token_digest: digest,
    created_at: new Date(now).toISOString(),
    last_seen_at: new Date(now).toISOString(),
  }, 'token_digest', 'id');
  return { token };
}

export async function validateGuest(db, request, now = Date.now()) {
  const token = readToken(request, GUEST_COOKIE);
  if (!token) return { state: 'missing', guest: null };
  const digest = await sha256Hex(token);
  const found = rows(await db.from('guests').select('id,token_digest').eq('token_digest', digest).limit(1));
  if (found.length !== 1 || found[0].token_digest !== digest) return { state: 'invalid', guest: null };
  return { state: 'valid', guest: { id: found[0].id } };
}

// 游客再次访问只刷新活跃时间；写入失败不影响本次浏览。
export async function touchGuest(db, guestId, now = Date.now()) {
  try {
    await db.from('guests').update({ last_seen_at: new Date(now).toISOString() })
      .eq('id', guestId).select('id');
  } catch {
    // 展示用的活跃度，允许缺失。
  }
}
