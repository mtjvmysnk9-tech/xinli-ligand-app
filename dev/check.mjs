// 本地契约检查：直接调用真实的 functions/ 模块（router / http / validate / passwords /
// sessions / limiter / config），只把数据层换成凭据无关的假数据库。
// 只证明应用逻辑，不证明真实 Provider、网关准入或部署环境行为。
// 运行方式：node（本项目无 node_modules；此文件不进任何上传目录）。
import assert from 'node:assert/strict';
import { createApplication } from '../functions/router.mjs';
import { createFakeDb } from './fake-db.mjs';
import { ADMIN_COOKIE, GUEST_COOKIE, SESSION_COOKIE } from '../functions/config.mjs';
import { PBKDF2_ITERATIONS } from '../functions/passwords.mjs';
import { LIMITS } from '../functions/limiter.mjs';
import { sha256Hex } from '../functions/sessions.mjs';

const ORIGIN = 'https://xinli-ligand.test';
const USER_PASSWORD = `pw-${crypto.randomUUID().slice(0, 8)}-long-enough`;
const ADMIN_PASSWORD = `admin-${crypto.randomUUID()}-${crypto.randomUUID()}`.slice(0, 40);

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}

function fixture() {
  const control = { mode: 'ok', dropTable: null, rejectTable: null, writes: [] };
  const db = createFakeDb(control);
  const handle = createApplication({ db, origin: ORIGIN });
  return { db, control, handle };
}

// 网关可能给出逻辑名 app，也可能给出物理名 app-d<32 hex>。
function ctx(path, { method = 'GET', body, cookies = [], origin = ORIGIN, headers = {}, ip = null, logical = false } = {}) {
  const merged = { ...headers };
  if (origin !== null) merged.origin = origin;
  if (cookies.length) merged.cookie = cookies.join('; ');
  if (ip) merged['x-forwarded-for'] = ip;
  if (body !== undefined) merged['content-type'] = 'application/json';
  const target = logical
    ? `${ORIGIN}/functions/v1/app${path}`
    : `https://provider.internal/functions/v1/app-d${'a'.repeat(32)}${path}`;
  return new Request(target, { method, headers: merged, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function call(handle, request) {
  const response = await handle({ request, requestId: 'local-check' });
  let body = null;
  try { body = await response.clone().json(); } catch { body = null; }
  return { status: response.status, body, cookies: response.headers.getSetCookie(), headers: response.headers };
}

// 只取指定 Cookie 名的 name=value 对，忽略属性。
function grab(result, name) {
  const found = result.cookies.find((line) => line.startsWith(`${name}=`));
  return found ? found.split(';')[0] : null;
}

const post = (handle, path, body, options = {}) => call(handle, ctx(path, { method: 'POST', body, ...options }));
const get = (handle, path, options = {}) => call(handle, ctx(path, options));
const unique = (prefix = 'user') => `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

const registerUser = (handle, username = unique(), password = USER_PASSWORD, extra = {}) =>
  post(handle, '/api/register', { username, password, ...extra });
const adminSetup = (handle, username = 'evelyn-admin', password = ADMIN_PASSWORD) =>
  post(handle, '/api/admin/setup', { username, password });

// —— 检查开始 ————————————————————————————————————————————————

await check('健康检查与逻辑名/物理名两种路径都可达', async () => {
  const { handle } = fixture();
  assert.equal((await get(handle, '/api/health')).body.ok, true);
  assert.equal((await get(handle, '/api/health', { logical: true })).status, 200);
  assert.equal((await get(handle, '/api/nope')).body.error, 'not_found');
  assert.equal((await post(handle, '/api/health', {})).body.error, 'method_not_allowed');
  assert.equal((await post(handle, '/api/session', {})).body.error, 'method_not_allowed');
});

await check('注册：签发 __Host- 会话 Cookie、清除游客 Cookie、库里只有派生结果', async () => {
  const { db, handle } = fixture();
  const created = await registerUser(handle, '  Alpha_01  ', USER_PASSWORD, { role_label: '家长' });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.username, 'alpha_01');
  assert.equal(created.body.user.role_label, '家长');
  assert.equal(created.body.user.role, 'user');
  const session = grab(created, SESSION_COOKIE);
  assert.ok(session, '应有会话 Cookie');
  const line = created.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(line.includes(flag), `缺少 ${flag}`);
  assert.ok(!/Domain=/i.test(line), '__Host- Cookie 不能带 Domain');
  assert.ok(created.cookies.some((c) => c.startsWith(`${GUEST_COOKIE}=;`) && /Max-Age=0/.test(c)), '应清除游客 Cookie');

  const users = db.dump('users');
  assert.equal(users.length, 1);
  const stored = JSON.stringify([...users, ...db.dump('sessions'), ...db.dump('login_events'), ...db.dump('auth_limiter')]);
  assert.ok(!stored.includes(USER_PASSWORD), '数据库任何表都不得出现明文口令');
  assert.notEqual(users[0].password_hash, USER_PASSWORD);
  assert.equal(users[0].password_iterations, PBKDF2_ITERATIONS);
  assert.equal(users[0].role, 'user');
  const token = session.slice(SESSION_COOKIE.length + 1);
  assert.equal(token.length, 43);
  const sessions = db.dump('sessions');
  assert.ok(!JSON.stringify(sessions).includes(token), '会话表只保存摘要，不保存明文令牌');
  assert.equal(sessions[0].token_digest, await sha256Hex(token));
  assert.equal(sessions[0].user_id, users[0].id);

  const who = await get(handle, '/api/session', { cookies: [session] });
  assert.equal(who.status, 200);
  assert.deepEqual(who.body.user, created.body.user);
});

await check('注册：输入策略逐项拒绝，且拒绝时不写库', async () => {
  const { db, handle } = fixture();
  for (const bad of ['ab', 'x'.repeat(33), '_leading', 'bad name', 'bad@name', '', null]) {
    const result = await registerUser(handle, bad);
    assert.equal(result.status, 400, `用户名应被拒绝：${JSON.stringify(bad)}`);
    assert.equal(result.body.error, 'invalid_username');
  }
  assert.equal((await registerUser(handle, unique(), 'short')).body.error, 'password_too_short');
  assert.equal((await registerUser(handle, unique(), 'x'.repeat(257))).body.error, 'invalid_password');
  assert.equal((await registerUser(handle, unique(), USER_PASSWORD, { role_label: '黑客' })).body.error, 'invalid_input');
  assert.equal(db.dump('users').length, 0, '被拒绝的注册不应落库');
  assert.equal(db.dump('sessions').length, 0);
});

await check('注册：同名并发只有一个成功，重复返回 username_taken', async () => {
  const { handle } = fixture();
  const results = await Promise.all([
    registerUser(handle, 'Bravo01'), registerUser(handle, 'bravo01'),
    registerUser(handle, ' BRAVO01 '), registerUser(handle, 'Bravo01'),
  ]);
  assert.equal(results.filter((r) => r.status === 201).length, 1, '只能有一个注册成功');
  assert.equal(results.filter((r) => r.body.error === 'username_taken').length, 3);
});

await check('注册：写入已提交但响应丢失时不重放，只报无法确认', async () => {
  const { db, control, handle } = fixture();
  control.dropTable = 'users';
  const result = await registerUser(handle, 'charlie01');
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'registration_unconfirmed');
  assert.equal(control.writes.filter((t) => t === 'users').length, 1, '不得重放写入');
  assert.equal(db.dump('users').filter((r) => r.username === 'charlie01').length, 1, '已提交的那一行保留');
  assert.equal(db.dump('sessions').length, 0, '未确认时不得再签发会话');
});

await check('登录：未知账号与错误口令同码，成功后累加登录次数并换发新会话', async () => {
  const { handle } = fixture();
  const name = unique();
  const created = await registerUser(handle, name);
  assert.equal((await post(handle, '/api/login', { username: name, password: 'wrong-password-123' })).body.error, 'invalid_credentials');
  assert.equal((await post(handle, '/api/login', { username: unique(), password: USER_PASSWORD })).body.error, 'invalid_credentials');
  const bad = await post(handle, '/api/login', { username: name, password: 'wrong-password-123' });
  assert.equal(bad.status, 401);
  const ok = await post(handle, '/api/login', { username: name, password: USER_PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.login_count, 2);
  assert.ok(grab(ok, SESSION_COOKIE) !== grab(created, SESSION_COOKIE), '每次登录换发新令牌');
  assert.ok(grab(ok, SESSION_COOKIE), '登录签发会话 Cookie');
  assert.equal(grab(ok, ADMIN_COOKIE), null, '普通登录不得签发管理员 Cookie');
});

await check('登录：固定窗口限流按次数生效并带 retry-after', async () => {
  const { db, handle } = fixture();
  const name = unique();
  await registerUser(handle, name);
  let last = null;
  for (let index = 0; index < LIMITS.login.maxAttempts; index += 1) {
    last = await post(handle, '/api/login', { username: name, password: `wrong-${index}-password-x` });
    assert.equal(last.status, 401, `第 ${index + 1} 次应是凭据错误`);
  }
  const blocked = await post(handle, '/api/login', { username: name, password: USER_PASSWORD });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, '应给出 retry-after');
  const bucket = db.dump('auth_limiter').find((row) => row.key === `login:${name}`);
  assert.equal(bucket.attempt_count, LIMITS.login.maxAttempts);
  assert.ok(last.status === 401);
});

await check('登录：成功不重置计数，窗口内继续累计', async () => {
  const { db, handle } = fixture();
  const name = unique();
  await registerUser(handle, name);
  await post(handle, '/api/login', { username: name, password: 'wrong-password-00000' });
  await post(handle, '/api/login', { username: name, password: USER_PASSWORD });
  const bucket = db.dump('auth_limiter').find((row) => row.key === `login:${name}`);
  assert.equal(bucket.attempt_count, 2, '成功登录不清零，避免用成功换取无限尝试');
});

await check('游客：签发独立游客 Cookie，会话读取报告游客状态', async () => {
  const { db, handle } = fixture();
  const anonymous = await get(handle, '/api/session');
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.body.user, null);
  assert.equal(anonymous.body.guest, false);

  const created = await post(handle, '/api/guest', {}, { ip: '198.51.100.7' });
  assert.equal(created.status, 201);
  assert.equal(created.body.ok, true);
  const guest = grab(created, GUEST_COOKIE);
  assert.ok(guest, '应有游客 Cookie');
  assert.ok(created.cookies.some((c) => c.startsWith(`${GUEST_COOKIE}=`) && /Max-Age=2592000/.test(c)), '游客 Cookie 30 天');
  assert.equal(db.dump('users').length, 0, '游客不创建账号');
  assert.equal(db.dump('guests').length, 1);
  const token = guest.slice(GUEST_COOKIE.length + 1);
  assert.ok(!JSON.stringify(db.dump('guests')).includes(token), '游客表只存摘要');

  const who = await get(handle, '/api/session', { cookies: [guest] });
  assert.equal(who.body.guest, true);
  assert.equal(who.body.user, null);
  const events = db.dump('login_events');
  assert.equal(events.filter((row) => row.kind === 'guest').length, 1);
  assert.equal(events.find((row) => row.kind === 'guest').ip, '198.51.100.0');
});

await check('游客：注册后清除游客 Cookie，账号与游客互不混淆', async () => {
  const { handle } = fixture();
  const guest = grab(await post(handle, '/api/guest', {}), GUEST_COOKIE);
  const created = await registerUser(handle);
  assert.ok(created.cookies.some((c) => c.startsWith(`${GUEST_COOKIE}=;`) && /Max-Age=0/.test(c)));
  const who = await get(handle, '/api/session', { cookies: [grab(created, SESSION_COOKIE), guest] });
  assert.equal(who.body.user.username, created.body.user.username);
});

await check('退出：先撤销库中会话再清 Cookie，重复退出幂等', async () => {
  const { db, handle } = fixture();
  const created = await registerUser(handle);
  const session = grab(created, SESSION_COOKIE);
  const out = await post(handle, '/api/logout', {}, { cookies: [session] });
  assert.equal(out.status, 200);
  assert.ok(out.cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/.test(c)));
  assert.ok(db.dump('sessions')[0].revoked_at, '会话应被撤销');
  assert.equal((await get(handle, '/api/session', { cookies: [session] })).body.user, null);
  assert.equal((await post(handle, '/api/logout', {}, { cookies: [session] })).status, 200, '重复退出幂等');
  assert.equal((await post(handle, '/api/logout', {})).status, 200, '未登录退出也算成功');
});

await check('退出：撤销结果未知时报无法确认并保留 Cookie', async () => {
  const { control, handle } = fixture();
  const created = await registerUser(handle);
  const session = grab(created, SESSION_COOKIE);
  control.rejectTable = 'sessions';
  const out = await post(handle, '/api/logout', {}, { cookies: [session] });
  assert.equal(out.status, 503);
  assert.equal(out.body.error, 'logout_unconfirmed');
  assert.ok(!out.cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`)), '未知结果时不谎报清除');
});

await check('管理员：首次播种开放、之后永久关闭', async () => {
  const { db, handle } = fixture();
  assert.equal((await get(handle, '/api/admin/status')).body.seeded, false);
  const seeded = await adminSetup(handle);
  assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
  assert.equal(seeded.body.user.role, 'admin');
  assert.ok(grab(seeded, ADMIN_COOKIE), '播种签发管理员 Cookie');
  assert.equal(grab(seeded, SESSION_COOKIE), null, '管理员 Cookie 与普通会话分开');
  const admin = db.dump('users').find((row) => row.role === 'admin');
  assert.ok(admin && admin.username === 'evelyn-admin');
  const stored = JSON.stringify(db.dump('users'));
  assert.ok(!stored.includes(ADMIN_PASSWORD), '管理员明文口令不得落库');
  assert.equal((await get(handle, '/api/admin/status')).body.seeded, true);
  const second = await adminSetup(handle, 'other-admin');
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'already_seeded');
  assert.equal(db.dump('users').filter((row) => row.role === 'admin').length, 1);
});

await check('管理员：播种口令长度下限高于普通账号', async () => {
  const { db, handle } = fixture();
  const short = await adminSetup(handle, 'evelyn-admin', 'twelve-chars');
  assert.equal(short.status, 400);
  assert.equal(short.body.error, 'password_too_short');
  assert.equal(db.dump('users').length, 0);
});

await check('管理员：普通账号凭据不能登录管理员入口', async () => {
  const { handle } = fixture();
  await adminSetup(handle);
  const created = await registerUser(handle, 'plainuser01');
  const wrong = await post(handle, '/api/admin/login', { username: 'plainuser01', password: USER_PASSWORD });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'invalid_credentials');
  const ok = await post(handle, '/api/admin/login', { username: 'evelyn-admin', password: ADMIN_PASSWORD });
  assert.equal(ok.status, 200);
  assert.ok(grab(ok, ADMIN_COOKIE));
  assert.equal(grab(ok, SESSION_COOKIE), null);
  assert.equal(created.status, 201);
});

await check('管理员：数据读取只接受管理员 Cookie，普通会话一律 401', async () => {
  const { handle } = fixture();
  const seeded = await adminSetup(handle);
  const userSession = grab(await registerUser(handle), SESSION_COOKIE);
  const admin = grab(seeded, ADMIN_COOKIE);
  for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/events']) {
    assert.equal((await get(handle, path)).status, 401, `${path} 未登录应 401`);
    const withUser = await get(handle, path, { cookies: [userSession] });
    assert.equal(withUser.status, 401, `${path} 普通会话不应放行`);
    assert.equal(withUser.body.error, 'login_required');
    assert.equal((await get(handle, path, { cookies: [admin] })).status, 200, `${path} 管理员应 200`);
  }
});

await check('管理员：失效的管理员 Cookie 只清除它自己', async () => {
  const { handle } = fixture();
  const stale = `${ADMIN_COOKIE}=${'A'.repeat(43)}`;
  const result = await get(handle, '/api/admin/users', { cookies: [stale] });
  assert.equal(result.status, 401);
  assert.equal(result.cookies.length, 1, '只应下发一个清除头');
  assert.ok(result.cookies[0].startsWith(`${ADMIN_COOKIE}=;`), '清除的是管理员 Cookie');
  assert.match(result.cookies[0], /Max-Age=0/);
});

await check('管理员：退出撤销管理员会话，不影响普通会话', async () => {
  const { db, handle } = fixture();
  const seeded = await adminSetup(handle);
  const admin = grab(seeded, ADMIN_COOKIE);
  const plain = await registerUser(handle, 'stay01');
  const userSession = grab(plain, SESSION_COOKIE);
  const out = await post(handle, '/api/admin/logout', {}, { cookies: [admin] });
  assert.equal(out.status, 200);
  assert.ok(out.cookies.some((c) => c.startsWith(`${ADMIN_COOKIE}=;`) && /Max-Age=0/.test(c)));
  assert.equal((await get(handle, '/api/admin/events', { cookies: [admin] })).status, 401);
  const who = await get(handle, '/api/session', { cookies: [userSession] });
  assert.equal(who.body.user.username, 'stay01', '普通会话不受管理员退出影响');
  assert.equal(db.dump('sessions').filter((row) => row.revoked_at).length, 1, '只撤销那一条会话');
});

await check('管理员：总览与列表来自真实事件，IP 只留粗粒度', async () => {
  const { db, handle } = fixture();
  const seeded = await adminSetup(handle);
  const admin = grab(seeded, ADMIN_COOKIE);
  const userSession = grab(await registerUser(handle, 'runner01', USER_PASSWORD, { role_label: '老师' }), SESSION_COOKIE);
  await post(handle, '/api/guest', {}, { ip: '203.0.113.55' });
  await post(handle, '/api/guest', {}, { ip: '203.0.113.99' });
  await post(handle, '/api/login', { username: 'runner01', password: USER_PASSWORD }, { ip: '198.51.100.23', cookies: [] });

  const overview = await get(handle, '/api/admin/overview', { cookies: [admin] });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.totals.accounts, 1);
  assert.equal(overview.body.totals.admins, 1);
  assert.equal(overview.body.totals.guests, 2);
  assert.equal(overview.body.last_24h.account_logins, 2);
  assert.equal(overview.body.last_24h.guest_visits, 2);
  assert.equal(overview.body.days.length, 7);
  const today = overview.body.days.at(-1);
  assert.equal(today.account + today.guest + today.admin, overview.body.last_24h.account_logins + overview.body.last_24h.guest_visits + overview.body.last_24h.admin_logins);
  assert.equal(today.account, 2);
  assert.equal(overview.body.top_logins[0].username, 'runner01');
  assert.equal(overview.body.top_logins[0].role_label, '老师');

  const users = await get(handle, '/api/admin/users', { cookies: [admin] });
  assert.equal(users.body.items.length, 2);
  assert.ok(users.body.items.every((row) => !('password_hash' in row) && !('password_salt' in row)), '列表不得带出凭据字段');

  const events = await get(handle, '/api/admin/events', { cookies: [admin] });
  const kinds = events.body.items.map((row) => row.kind);
  assert.ok(kinds.includes('admin_setup') && kinds.includes('guest') && kinds.includes('account'));
  const guestEvents = events.body.items.filter((row) => row.kind === 'guest');
  assert.deepEqual([...new Set(guestEvents.map((row) => row.ip))].sort(), ['203.0.113.0']);
  assert.ok(events.body.items.every((row) => !/^203\.0\.113\.(55|99)$/.test(row.ip ?? '')), '完整 IP 不得入库');
  assert.equal(events.body.items.every((row) => row.user_agent === null || row.user_agent.length <= 200), true);
  assert.equal(db.dump('login_events').length, events.body.items.length);
});

await check('管理员：登录流水写入失败不阻断登录', async () => {
  const { db, control, handle } = fixture();
  await adminSetup(handle);
  control.rejectTable = 'login_events';
  const ok = await post(handle, '/api/admin/login', { username: 'evelyn-admin', password: ADMIN_PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal(db.dump('login_events').filter((row) => row.kind === 'admin').length, 0);
  assert.ok(grab(ok, ADMIN_COOKIE), '事件失败仍然签发会话');
});

await check('CSRF：不安全方法必须来自固定来源，GET 不受影响', async () => {
  const { db, handle } = fixture();
  const evil = await registerUser(handle, 'attacker01');
  await call(handle, ctx('/api/register', { method: 'POST', body: { username: 'another01', password: USER_PASSWORD }, origin: 'https://evil.test' }));
  assert.equal(evil.status, 201, '正常来源仍可用');
  const blocked = await call(handle, ctx('/api/guest', { method: 'POST', body: {}, origin: 'https://evil.test' }));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'origin_forbidden');
  const noOrigin = await post(handle, '/api/guest', {}, { origin: null });
  assert.equal(noOrigin.body.error, 'origin_forbidden');
  assert.equal((await get(handle, '/api/health', { origin: 'https://evil.test' })).status, 200);
  assert.equal(db.dump('guests').length, 0, '被拒绝的请求不得写入');
});

await check('输入边界：超大请求体、错误类型与超长 Cookie', async () => {
  const { db, handle } = fixture();
  const huge = await call(handle, ctx('/api/login', { method: 'POST', body: undefined }));
  assert.equal(huge.status, 400);
  const oversized = await call(handle, new Request(
    `https://provider.internal/functions/v1/app-d${'a'.repeat(32)}/api/login`,
    { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'u'.repeat(9000), password: 'x'.repeat(9000) }) },
  ));
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error, 'payload_too_large');
  const wrongType = await call(handle, new Request(
    `https://provider.internal/functions/v1/app-d${'a'.repeat(32)}/api/login`,
    { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body: 'username=x' },
  ));
  assert.equal(wrongType.body.error, 'invalid_input');
  const fatCookie = await get(handle, '/api/session', { cookies: [`${SESSION_COOKIE}=${'A'.repeat(43)}`.repeat(200)] });
  assert.equal(fatCookie.status, 400);
  assert.equal(fatCookie.body.error, 'invalid_credentials');
  // 超长 UA 截断入库，不整段留存。
  await call(handle, ctx('/api/guest', { method: 'POST', body: {}, headers: { 'user-agent': 'A'.repeat(500) } }));
  assert.equal(db.dump('login_events')[0].user_agent.length, 200);
});

await check('会话过期后不再放行，读取当前状态时顺手清除', async () => {
  const { db, handle } = fixture();
  const session = grab(await registerUser(handle), SESSION_COOKIE);
  const digest = await sha256Hex(session.slice(SESSION_COOKIE.length + 1));
  // 直接把过期时间推到过去，模拟 12 小时之后。
  await db.from('sessions').update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq('token_digest', digest).select('token_digest');
  const result = await get(handle, '/api/session', { cookies: [session] });
  assert.equal(result.body.user, null);
  assert.ok(result.cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/.test(c)), '过期会话应清除会话 Cookie');
  const guarded = await get(handle, '/api/admin/overview', { cookies: [session] });
  assert.equal(guarded.status, 401);
  // 游客 Cookie 同理：库里没有对应行时按失效清除，且不误清会话 Cookie。
  const ghost = `${GUEST_COOKIE}=${'B'.repeat(43)}`;
  const guestCleared = await get(handle, '/api/session', { cookies: [ghost] });
  assert.equal(guestCleared.body.guest, false);
  assert.ok(guestCleared.cookies.some((c) => c.startsWith(`${GUEST_COOKIE}=;`) && /Max-Age=0/.test(c)));
  assert.ok(!guestCleared.cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`)), '不误清其它 Cookie');
});

await check('限流表不可用时失败关闭，不放行登录', async () => {
  const { control, handle } = fixture();
  control.rejectTable = 'auth_limiter';
  const result = await post(handle, '/api/login', { username: 'someone01', password: USER_PASSWORD });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'limiter_unavailable');
});

await check('登录：统计写入响应丢失时仍然放行（凭据已验证）', async () => {
  const { control, handle } = fixture();
  await registerUser(handle, 'counter01');
  control.dropTable = 'users';
  const result = await post(handle, '/api/login', { username: 'counter01', password: USER_PASSWORD });
  assert.equal(result.status, 200);
  assert.ok(grab(result, SESSION_COOKIE), '仍签发会话');
  assert.equal(control.writes.filter((t) => t === 'users').length, 2, '注册 1 次 + 登录统计 1 次，不再重放');
});

await check('注册：会话写入结果未知时不签发 Cookie、不重放', async () => {
  const { control, db, handle } = fixture();
  control.dropTable = 'sessions';
  const result = await registerUser(handle, 'nosession1');
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'session_unavailable');
  assert.ok(!result.cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`)), '未知结果不发凭据');
  assert.equal(db.dump('users').filter((row) => row.username === 'nosession1').length, 1);
  assert.equal(control.writes.filter((t) => t === 'sessions').length, 1, '会话写入不重放');
  // 账号其实已建成：用同一凭据登录即可恢复，不需要第二次注册。
  const recovered = await post(handle, '/api/login', { username: 'nosession1', password: USER_PASSWORD });
  assert.equal(recovered.status, 200);
});

await check('来源配置：部署来源必须 HTTPS，本地演练只放行 loopback', async () => {
  const insecure = createApplication({ db: createFakeDb({ mode: 'ok', writes: [] }), origin: 'http://example.test' });
  const blocked = await call(insecure, ctx('/api/guest', { method: 'POST', body: {}, origin: null }));
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error, 'application_auth_not_configured');

  const local = createApplication({ db: createFakeDb({ mode: 'ok', writes: [] }), origin: 'http://127.0.0.1:8123' });
  const ok = await call(local, new Request('http://127.0.0.1:8123/functions/v1/app/api/guest', {
    method: 'POST', headers: { origin: 'http://127.0.0.1:8123', 'content-type': 'application/json' }, body: '{}',
  }));
  assert.equal(ok.status, 201, 'loopback 本地预览可写');
  const wrong = await call(local, new Request('http://127.0.0.1:8123/functions/v1/app/api/guest', {
    method: 'POST', headers: { origin: 'http://evil.test', 'content-type': 'application/json' }, body: '{}',
  }));
  assert.equal(wrong.body.error, 'origin_forbidden');
});

await check('管理员：CSV 导出需管理员权限，返回正确格式与内容', async () => {
  const { db, handle } = fixture();
  const seeded = await adminSetup(handle);
  const admin = grab(seeded, ADMIN_COOKIE);
  const userSession = grab(await registerUser(handle, 'exporter01', USER_PASSWORD, { role_label: '教练' }), SESSION_COOKIE);
  await post(handle, '/api/guest', {}, { ip: '198.51.100.77' });

  // 未登录应 401
  const unauth = await get(handle, '/api/admin/export.csv?kind=events');
  assert.equal(unauth.status, 401);

  // 普通用户应 401
  const userTry = await get(handle, '/api/admin/export.csv?kind=users', { cookies: [userSession] });
  assert.equal(userTry.status, 401);

  // 管理员应 200 且返回 CSV
  for (const kind of ['events', 'users', 'guests']) {
    const result = await get(handle, `/api/admin/export.csv?kind=${kind}`, { cookies: [admin] });
    assert.equal(result.status, 200, `${kind} 导出应 200`);
    const text = await result.text();
    assert.ok(text.startsWith('﻿'), `${kind} 应有 UTF-8 BOM`);
    const lines = text.trim().split(/\r?\n/);
    assert.ok(lines.length >= 2, `${kind} 至少应有表头 + 1 行数据`);
    const headers = lines[0].split(',');
    assert.ok(headers.length > 0, `${kind} 表头不应为空`);
  }

  // 验证 events 导出包含刚创建的事件
  const eventsCsv = await get(handle, '/api/admin/export.csv?kind=events', { cookies: [admin] });
  const eventsText = await eventsCsv.text();
  assert.ok(eventsText.includes('exporter01'), 'events 导出应包含注册事件');
  assert.ok(eventsText.includes('guest'), 'events 导出应包含游客事件');

  // 验证 users 导出包含账号信息
  const usersCsv = await get(handle, '/api/admin/export.csv?kind=users', { cookies: [admin] });
  const usersText = await usersCsv.text();
  assert.ok(usersText.includes('exporter01'), 'users 导出应包含注册的账号');
  assert.ok(usersText.includes('教练'), 'users 导出应包含角色标签');

  // 无效 kind 应 400
  const badKind = await get(handle, '/api/admin/export.csv?kind=invalid', { cookies: [admin] });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.body.error, 'invalid_input');
});

const failures = results.filter((row) => !row.ok);
for (const row of results) {
  if (!row.ok) console.log(`FAIL ${row.name}\n     ${row.detail}`);
}
console.log(`\n${results.length - failures.length}/${results.length} 项通过`);
export default { results, failures, total: results.length };
