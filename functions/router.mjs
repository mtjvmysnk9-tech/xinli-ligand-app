// 应用路由：注册 / 登录 / 退出 / 游客会话 / 当前状态 / 管理员播种 / 管理员登录 / 访问记录读取。
// 应用身份一律来自本应用自己的会话校验（数据库中的会话摘要），
// 绝不使用 ctx.user、平台身份、Host 头或浏览器提交的 user_id / role。
import { AppError, applicationPath, errorJson, json, readJson, requireTrustedOrigin, rows, clientMeta } from './http.mjs';
import { canonicalUsername, loginPassword, validatePassword, validateRoleLabel } from './validate.mjs';
import { hashPassword, verifyPassword, verifyPasswordAgainstDummy } from './passwords.mjs';
import {
  adminCookie, clearCookie, createGuestSession, createSession, guestCookie, revokeSession,
  sessionCookie, touchGuest, validateGuest, validateSession,
} from './sessions.mjs';
import { consume } from './limiter.mjs';
import {
  ADMIN_COOKIE, ADMIN_PASSWORD_MIN_CHARS, GUEST_COOKIE, SESSION_COOKIE, USER_PASSWORD_MIN_CHARS,
} from './config.mjs';
import { buildCsv } from './export.mjs';

const USER_COLUMNS = 'id,username,role,display_name,created_at,last_login_at,login_count';
const AUTH_COLUMNS = `${USER_COLUMNS},password_salt,password_hash,password_iterations`;
const LIST_LIMIT = 500;
const PAGE_LIMIT = 200;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// 会话校验失败时记住是哪个 Cookie 失败了，401 只清除对应的那一个。
class SessionRequired extends Error {
  constructor(state, cookieName) {
    super('login_required');
    this.state = state;
    this.cookieName = cookieName;
  }
}

const retryAfter = (result) => ({ 'retry-after': String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) });

// Cookie 存在但无效（过期 / 已撤销 / 被篡改）时顺手清掉，避免浏览器一直带着失效凭据。
function unauthorized(state, cookieName) {
  return state === 'invalid'
    ? errorJson('login_required', 401, {}, [clearCookie(cookieName)])
    : errorJson('login_required', 401);
}

function publicUser(row) {
  return {
    username: row.username,
    role: row.role === 'admin' ? 'admin' : 'user',
    role_label: typeof row.display_name === 'string' ? row.display_name : '其它',
    created_at: row.created_at,
    last_login_at: row.last_login_at ?? null,
    login_count: Number.isSafeInteger(row.login_count) ? row.login_count : 0,
  };
}

async function findUser(db, username) {
  return rows(await db.from('users').select('id').eq('username', username).limit(1));
}

async function loadUser(db, userId, cookieName) {
  const found = rows(await db.from('users').select(USER_COLUMNS).eq('id', userId).limit(1));
  if (found.length !== 1 || typeof found[0].username !== 'string') throw new SessionRequired('invalid', cookieName);
  return found[0];
}

// 会话凭据只在服务端校验；管理员权限来自数据库里的 role，不接受任何浏览器声明。
async function requireSession(db, request, cookieName) {
  const result = await validateSession(db, request, cookieName);
  if (result.state !== 'valid') throw new SessionRequired(result.state, cookieName);
  return result.session;
}

async function requireAdmin(db, request) {
  const session = await requireSession(db, request, ADMIN_COOKIE);
  const user = await loadUser(db, session.userId, ADMIN_COOKIE);
  if (user.role !== 'admin') throw new AppError('forbidden', 403);
  return user;
}

// 登录流水是遥测，不是授权依据：写入失败绝不阻断登录本身。
async function recordEvent(db, { kind, userId = null, username = null, request }) {
  const meta = clientMeta(request);
  try {
    await db.from('login_events').insertIfAbsent({
      id: crypto.randomUUID(),
      kind,
      user_id: userId,
      username,
      ip: meta.ip,
      user_agent: meta.userAgent,
      created_at: new Date().toISOString(),
    }, { onConflict: 'id' }).select('id');
  } catch {
    // 明确吞掉：事件缺失只影响统计完整性。
  }
}

async function countAdmins(db) {
  return rows(await db.from('users').select('id,created_at').eq('role', 'admin').limit(5));
}

// 登录时间与次数只用于展示和统计：写入失败或结果未知时不阻断已经验证通过的登录，
// 退回本次读到的旧值（宁可少计一次，也不重放写入）。
async function bumpLogin(db, user, nowIso) {
  const next = (Number.isSafeInteger(user.login_count) ? user.login_count : 0) + 1;
  try {
    const updated = rows(await db.from('users')
      .update({ last_login_at: nowIso, login_count: next })
      .eq('id', user.id).select(USER_COLUMNS));
    if (updated.length === 1) return updated[0];
  } catch {
    // 明确忽略：会话签发不依赖这一步。
  }
  return user;
}

async function register(db, request) {
  const body = await readJson(request);
  const username = canonicalUsername(body?.username);
  const password = validatePassword(body?.password, USER_PASSWORD_MIN_CHARS);
  const label = validateRoleLabel(body?.role_label);
  // 注册同样受限流约束（按规范化用户名计数）。
  const limit = await consume(db, 'register', username);
  if (!limit.allowed) return errorJson('rate_limited', 429, retryAfter(limit));

  if ((await findUser(db, username)).length > 0) return errorJson('username_taken', 409);

  const derived = await hashPassword(password);
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  // 唯一性由数据库在 username 上判定：并发注册同名时只有一个写入者成功。
  let created;
  try {
    created = rows(await db.from('users').insertIfAbsent({
      id,
      username,
      password_salt: derived.salt,
      password_hash: derived.hash,
      password_iterations: derived.iterations,
      role: 'user',
      display_name: label,
      created_at: nowIso,
      last_login_at: nowIso,
      login_count: 1,
    }, { onConflict: 'username' }).select('id'));
  } catch (error) {
    if (error instanceof AppError) throw error;
    // 连接中断 / 响应丢失：写入可能已经提交。绝不重放，让用户用同一用户名登录来核对结果。
    return errorJson('registration_unconfirmed', 503);
  }

  if (created.length !== 1) {
    if ((await findUser(db, username)).length === 1) return errorJson('username_taken', 409);
    // 既没写成、也读不到同名记录：结果无法确认，不做任何重放。
    return errorJson('registration_unconfirmed', 503);
  }

  const { token } = await createSession(db, id);
  await recordEvent(db, { kind: 'account', userId: id, username, request });
  return json({ user: publicUser({ id, username, role: 'user', display_name: label, created_at: nowIso, last_login_at: nowIso, login_count: 1 }) },
    201, {}, [sessionCookie(token), clearCookie(GUEST_COOKIE)]);
}

async function login(db, request) {
  const body = await readJson(request);
  const username = canonicalUsername(body?.username);
  // 先消费配额：对不存在的账号同样计数，避免用失败次数探测账号是否存在。
  const limit = await consume(db, 'login', username);
  if (!limit.allowed) return errorJson('rate_limited', 429, retryAfter(limit));

  const password = loginPassword(body?.password);
  const found = rows(await db.from('users')
    .select(AUTH_COLUMNS).eq('username', username).limit(1));

  if (found.length !== 1) {
    // 用户名不存在时也付出同等计算代价，再返回与密码错误相同的错误码。
    await verifyPasswordAgainstDummy(password);
    return errorJson('invalid_credentials', 401);
  }

  const user = found[0];
  const ok = await verifyPassword(password, {
    salt: user.password_salt, hash: user.password_hash, iterations: user.password_iterations,
  });
  if (!ok) return errorJson('invalid_credentials', 401);

  // 成功登录不重置窗口计数：固定窗口内已消费的配额继续累计。
  const nowIso = new Date().toISOString();
  const bumped = await bumpLogin(db, user, nowIso);
  const { token } = await createSession(db, user.id);
  await recordEvent(db, { kind: 'account', userId: user.id, username: user.username, request });
  return json({ user: publicUser(bumped) }, 200, {}, [sessionCookie(token), clearCookie(GUEST_COOKIE)]);
}

async function logout(db, request) {
  const result = await validateSession(db, request, SESSION_COOKIE);
  if (result.state === 'valid' && result.session) {
    try {
      await revokeSession(db, result.session.digest);
    } catch {
      // 撤销结果未知：保留 Cookie，让用户可以在会话仍有效时重试退出；不重放、不谎报成功。
      return errorJson('logout_unconfirmed', 503);
    }
  }
  // 先撤销数据库会话，再清除 Cookie。
  return json({ ok: true }, 200, {}, [clearCookie(SESSION_COOKIE)]);
}

async function guest(db, request) {
  const meta = clientMeta(request);
  const limit = await consume(db, 'guest', meta.rateKey);
  if (!limit.allowed) return errorJson('rate_limited', 429, retryAfter(limit));
  const { token } = await createGuestSession(db);
  await recordEvent(db, { kind: 'guest', request });
  // 只回执状态，游客行 ID 不外泄：浏览器凭 Cookie 即可恢复游客身份。
  return json({ ok: true }, 201, {}, [guestCookie(token)]);
}

// 一次读取当前浏览器的两种状态，供页面加载时恢复登录态（只读，不改任何数据）。
// 读到已失效的 Cookie 时顺手清除，避免浏览器长期携带死凭据。
async function session(db, request) {
  const account = await validateSession(db, request, SESSION_COOKIE);
  const cookies = [];
  let user = null;
  if (account.state === 'valid') {
    try {
      user = publicUser(await loadUser(db, account.session.userId, SESSION_COOKIE));
    } catch {
      user = null;
      cookies.push(clearCookie(SESSION_COOKIE));
    }
  } else if (account.state === 'invalid') {
    cookies.push(clearCookie(SESSION_COOKIE));
  }
  const guestState = await validateGuest(db, request);
  if (guestState.state === 'valid' && guestState.guest) await touchGuest(db, guestState.guest.id);
  if (guestState.state === 'invalid') cookies.push(clearCookie(GUEST_COOKIE));
  return json({ user, guest: guestState.state === 'valid' }, 200, {}, cookies);
}

// 首次运行播种管理员：仅在当前没有任何 admin 角色时开放，播种完成后永久关闭。
async function adminSetup(db, request) {
  const limit = await consume(db, 'admin_setup', 'global');
  if (!limit.allowed) return errorJson('rate_limited', 429, retryAfter(limit));

  const before = await countAdmins(db);
  if (before.length > 0) return errorJson('already_seeded', 409);

  const body = await readJson(request);
  const username = canonicalUsername(body?.username);
  const password = validatePassword(body?.password, ADMIN_PASSWORD_MIN_CHARS);

  if ((await findUser(db, username)).length > 0) return errorJson('username_taken', 409);

  const derived = await hashPassword(password);
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  let created;
  try {
    created = rows(await db.from('users').insertIfAbsent({
      id,
      username,
      password_salt: derived.salt,
      password_hash: derived.hash,
      password_iterations: derived.iterations,
      role: 'admin',
      display_name: '管理员',
      created_at: nowIso,
      last_login_at: nowIso,
      login_count: 1,
    }, { onConflict: 'username' }).select('id'));
  } catch (error) {
    if (error instanceof AppError) throw error;
    // 播种写入结果未知：不重放，避免造出第二个管理员。
    return errorJson('admin_setup_unconfirmed', 503);
  }
  if (created.length !== 1) return errorJson('admin_setup_unconfirmed', 503);

  // 并发播种兜底：若出现多行 admin，把本次写入的行降级，只保留最早的一行。
  const after = await countAdmins(db);
  if (after.length > 1) {
    const earliest = [...after].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    if (earliest && earliest.id !== id) {
      try {
        await db.from('users').update({ role: 'retired' }).eq('id', id).select('id');
      } catch {
        // 降级结果未知：仍然不放行会话，下面直接返回冲突。
      }
      return errorJson('already_seeded', 409);
    }
  }

  const { token } = await createSession(db, id);
  await recordEvent(db, { kind: 'admin_setup', userId: id, username, request });
  return json({ user: publicUser({ id, username, role: 'admin', display_name: '管理员', created_at: nowIso, last_login_at: nowIso, login_count: 1 }) },
    201, {}, [adminCookie(token)]);
}

async function adminLogin(db, request) {
  const body = await readJson(request);
  const username = canonicalUsername(body?.username);
  const limit = await consume(db, 'admin_login', username);
  if (!limit.allowed) return errorJson('rate_limited', 429, retryAfter(limit));

  const password = loginPassword(body?.password);
  const found = rows(await db.from('users')
    .select(AUTH_COLUMNS).eq('username', username).limit(1));

  if (found.length !== 1 || found[0].role !== 'admin') {
    await verifyPasswordAgainstDummy(password);
    return errorJson('invalid_credentials', 401);
  }

  const user = found[0];
  const ok = await verifyPassword(password, {
    salt: user.password_salt, hash: user.password_hash, iterations: user.password_iterations,
  });
  if (!ok) return errorJson('invalid_credentials', 401);

  const nowIso = new Date().toISOString();
  const bumped = await bumpLogin(db, user, nowIso);
  const { token } = await createSession(db, user.id);
  await recordEvent(db, { kind: 'admin', userId: user.id, username: user.username, request });
  return json({ user: publicUser(bumped) }, 200, {}, [adminCookie(token)]);
}

async function adminLogout(db, request) {
  const result = await validateSession(db, request, ADMIN_COOKIE);
  if (result.state === 'valid' && result.session) {
    try {
      await revokeSession(db, result.session.digest);
    } catch {
      return errorJson('logout_unconfirmed', 503);
    }
  }
  return json({ ok: true }, 200, {}, [clearCookie(ADMIN_COOKIE)]);
}

const desc = (field) => (a, b) => Date.parse(b[field] ?? '') - Date.parse(a[field] ?? '');
const within = (value, ms, now) => Number.isFinite(Date.parse(value ?? '')) && now - Date.parse(value) < ms;
const dayKey = (value) => new Date(Date.parse(value) + 8 * HOUR_MS).toISOString().slice(0, 10);

async function adminOverview(db, request) {
  await requireAdmin(db, request);
  const now = Date.now();
  const users = rows(await db.from('users').select(USER_COLUMNS).limit(LIST_LIMIT));
  const guests = rows(await db.from('guests').select('id,created_at,last_seen_at').limit(LIST_LIMIT));
  const events = rows(await db.from('login_events')
    .select('id,kind,username,created_at').limit(LIST_LIMIT));

  const accounts = users.filter((row) => row.role === 'user');
  const admins = users.filter((row) => row.role === 'admin');
  const recent = events.filter((row) => within(row.created_at, DAY_MS, now));
  const byKind = (list, kind) => list.filter((row) => row.kind === kind).length;

  const days = [];
  for (let index = 6; index >= 0; index -= 1) {
    const key = new Date(now - index * DAY_MS + 8 * HOUR_MS).toISOString().slice(0, 10);
    const inDay = events.filter((row) => dayKey(row.created_at) === key);
    days.push({ date: key, account: byKind(inDay, 'account'), guest: byKind(inDay, 'guest'), admin: byKind(inDay, 'admin') });
  }

  return json({
    generated_at: new Date(now).toISOString(),
    window_hours: 24,
    list_bound: LIST_LIMIT,
    totals: {
      accounts: accounts.length,
      admins: admins.length,
      guests: guests.length,
      active_accounts_7d: accounts.filter((row) => within(row.last_login_at, 7 * DAY_MS, now)).length,
    },
    last_24h: {
      account_logins: byKind(recent, 'account'),
      guest_visits: byKind(recent, 'guest'),
      admin_logins: byKind(recent, 'admin'),
    },
    days,
    top_logins: [...accounts].sort(desc('last_login_at')).slice(0, 5)
      .map((row) => ({ username: row.username, role_label: row.display_name, last_login_at: row.last_login_at, login_count: row.login_count })),
  });
}

async function adminUsers(db, request) {
  await requireAdmin(db, request);
  const users = rows(await db.from('users').select(USER_COLUMNS).limit(LIST_LIMIT));
  return json({
    list_bound: LIST_LIMIT,
    page_limit: PAGE_LIMIT,
    items: users.filter((row) => row.role !== 'retired').sort(desc('last_login_at')).slice(0, PAGE_LIMIT)
      .map((row) => ({ ...publicUser(row), id: row.id })),
  });
}

async function adminEvents(db, request) {
  await requireAdmin(db, request);
  const events = rows(await db.from('login_events')
    .select('id,kind,user_id,username,ip,user_agent,created_at').limit(LIST_LIMIT));
  return json({
    list_bound: LIST_LIMIT,
    page_limit: PAGE_LIMIT,
    items: events.sort(desc('created_at')).slice(0, PAGE_LIMIT),
  });
}

const EXPORT_KINDS = {
  events: { table: 'login_events', columns: ['id', 'kind', 'username', 'ip', 'user_agent', 'created_at'] },
  users: { table: 'users', columns: ['id', 'username', 'role', 'display_name', 'created_at', 'last_login_at', 'login_count'] },
  guests: { table: 'guests', columns: ['id', 'created_at', 'last_seen_at'] },
};

async function adminExport(db, request) {
  await requireAdmin(db, request);
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const spec = EXPORT_KINDS[kind];
  if (!spec) return errorJson('invalid_input', 400);
  const data = rows(await db.from(spec.table).select(spec.columns.join(',')).limit(LIST_LIMIT));
  const csv = buildCsv(data, spec.columns);
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${spec.table}_${Date.now()}.csv"`,
    },
  });
}

const READ_ONLY = new Set(['/api/session', '/api/health', '/api/admin/status', '/api/admin/overview', '/api/admin/users', '/api/admin/events', '/api/admin/export.csv']);

async function route(db, request, origin) {
  requireTrustedOrigin(request, origin);
  const path = applicationPath(request);
  const method = request.method;

  if (path === '/api/health' && method === 'GET') return json({ ok: true, service: 'xinli-ligand-auth' });
  if (path === '/api/admin/status' && method === 'GET') return json({ seeded: (await countAdmins(db)).length > 0 });

  if (path === '/api/session' && method === 'GET') return session(db, request);
  if (path === '/api/register' && method === 'POST') return register(db, request);
  if (path === '/api/login' && method === 'POST') return login(db, request);
  if (path === '/api/logout' && method === 'POST') return logout(db, request);
  if (path === '/api/guest' && method === 'POST') return guest(db, request);

  if (path === '/api/admin/setup' && method === 'POST') return adminSetup(db, request);
  if (path === '/api/admin/login' && method === 'POST') return adminLogin(db, request);
  if (path === '/api/admin/logout' && method === 'POST') return adminLogout(db, request);
  if (path === '/api/admin/overview' && method === 'GET') return adminOverview(db, request);
  if (path === '/api/admin/users' && method === 'GET') return adminUsers(db, request);
  if (path === '/api/admin/events' && method === 'GET') return adminEvents(db, request);
  if (path === '/api/admin/export.csv' && method === 'GET') return adminExport(db, request);

  if (READ_ONLY.has(path)) throw new AppError('method_not_allowed', 405);
  throw new AppError('not_found', 404);
}

// 依赖注入只用于本地演练；ctx 只用于取 request，不使用其中的平台身份。
export function createApplication({ db, origin }) {
  return async function handle(ctx) {
    const request = ctx.request ?? ctx;
    try {
      return await route(db, request, typeof origin === 'function' ? origin() : origin);
    } catch (error) {
      if (error instanceof SessionRequired) return unauthorized(error.state, error.cookieName);
      if (error instanceof AppError) return errorJson(error.code, error.status);
      return errorJson('service_unavailable', 503);
    }
  };
}
