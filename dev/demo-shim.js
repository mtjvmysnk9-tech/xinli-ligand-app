/*
 * 本机演示后端（只注入「提交包」这份副本，Sites 生产副本不含此文件）。
 *
 * 用途：没有站点 Function 时（评委在本地双击打开 HTML，或静态托管），
 * 用 localStorage 复刻 /api/... 的响应形状与错误码，让注册、登录、游客、
 * 管理员看板仍然可以真的点通。
 *
 * 明确的边界：数据只存在当前浏览器；不做限流；密码只存加盐摘要（真实后端是
 * 15 万轮 PBKDF2），所以横幅里要求使用者不要输入真实密码。
 */
(function () {
  "use strict";

  var KEY = "xinli.demo.v1";
  var HOUR = 3600000, DAY = 24 * HOUR;
  var USER_MIN = 10, ADMIN_MIN = 15, MAX_BYTES = 256;
  var LABELS = ["家长", "老师", "教练", "其它"];
  var LIST_BOUND = 500, PAGE_LIMIT = 200;

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(value, shift) { return ((value >>> shift) | (value << (32 - shift))) >>> 0; }

  function sha256(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length;
    var total = (Math.floor((len + 8) / 64) + 1) * 64;
    var msg = new Uint8Array(total);
    msg.set(bytes);
    msg[len] = 0x80;
    var bits = len * 8;
    var hi = Math.floor(bits / 4294967296), lo = bits % 4294967296;
    msg[total - 8] = (hi >>> 24) & 255; msg[total - 7] = (hi >>> 16) & 255;
    msg[total - 6] = (hi >>> 8) & 255; msg[total - 5] = hi & 255;
    msg[total - 4] = (lo >>> 24) & 255; msg[total - 3] = (lo >>> 16) & 255;
    msg[total - 2] = (lo >>> 8) & 255; msg[total - 1] = lo & 255;

    var w = new Uint32Array(64);
    var i, block;
    for (block = 0; block < total; block += 64) {
      for (i = 0; i < 16; i++) {
        var o = block + i * 4;
        w[i] = ((msg[o] << 24) | (msg[o + 1] << 16) | (msg[o + 2] << 8) | msg[o + 3]) >>> 0;
      }
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        var s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
        var s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    var out = [];
    for (i = 0; i < 8; i++) out.push((h[i] >>> 24) & 255, (h[i] >>> 16) & 255, (h[i] >>> 8) & 255, h[i] & 255);
    return new Uint8Array(out);
  }

  function utf8(text) { return new TextEncoder().encode(text); }

  function toHex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += ("0" + bytes[i].toString(16)).slice(-2);
    return s;
  }

  // 演示只需要「读不回明文」：真实后端用 15 万轮 PBKDF2，这里 2000 轮摘要足够跑通流程。
  function derive(password, salt) {
    var acc = sha256(utf8(salt + "|" + password));
    for (var i = 0; i < 2000; i++) acc = sha256(utf8(toHex(acc) + salt));
    return toHex(acc);
  }

  function randHex(n) {
    var out = "";
    for (var i = 0; i < n; i++) out += ("0" + ((Math.random() * 256) | 0).toString(16)).slice(-2);
    return out;
  }

  function uid() { return "d" + Date.now().toString(36) + randHex(6); }
  function nowIso() { return new Date().toISOString(); }

  function byteLen(text) {
    try { return utf8(text).length; } catch (e) { return String(text).length; }
  }

  function fail(code, status) { return { __fail: true, code: code, status: status }; }

  function canonicalUsername(raw) {
    if (typeof raw !== "string") return fail("invalid_username", 400);
    var value = raw.trim().toLowerCase();
    if (value.length < 3 || value.length > 32) return fail("invalid_username", 400);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) return fail("invalid_username", 400);
    return value;
  }

  function checkPassword(raw, min) {
    if (typeof raw !== "string") return fail("invalid_password", 400);
    if (Array.from(raw).length < min) return fail("password_too_short", 400);
    if (byteLen(raw) > MAX_BYTES) return fail("invalid_password", 400);
    return raw;
  }

  function checkLabel(raw) {
    if (raw === undefined || raw === null || raw === "") return "其它";
    if (typeof raw !== "string") return fail("invalid_input", 400);
    var value = raw.trim();
    return LABELS.indexOf(value) < 0 ? fail("invalid_input", 400) : value;
  }

  function checkLoginPassword(raw) {
    if (typeof raw !== "string") return fail("invalid_credentials", 400);
    if (byteLen(raw) > MAX_BYTES) return fail("invalid_credentials", 400);
    return raw;
  }

  function fresh() {
    return { users: [], guests: [], events: [], me: { user: null, admin: null, guest: null }, samples: false };
  }

  var db = null;

  function load() {
    var base = fresh();
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return base;
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.users)) return base;
      base.users = parsed.users;
      base.guests = Array.isArray(parsed.guests) ? parsed.guests : [];
      base.events = Array.isArray(parsed.events) ? parsed.events : [];
      if (parsed.me) {
        base.me.user = parsed.me.user || null;
        base.me.admin = parsed.me.admin || null;
        base.me.guest = parsed.me.guest || null;
      }
      base.samples = !!parsed.samples;
      return base;
    } catch (e) { return base; }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); return true; } catch (e) { return false; }
  }

  function publicUser(row) {
    return {
      username: row.username,
      role: row.role === "admin" ? "admin" : "user",
      role_label: typeof row.display_name === "string" ? row.display_name : "其它",
      created_at: row.created_at,
      last_login_at: row.last_login_at || null,
      login_count: row.login_count || 0
    };
  }

  function find(name) {
    for (var i = 0; i < db.users.length; i++) if (db.users[i].username === name) return db.users[i];
    return null;
  }

  function findById(id) {
    for (var i = 0; i < db.users.length; i++) if (db.users[i].id === id) return db.users[i];
    return null;
  }

  function admins() {
    return db.users.filter(function (row) { return row.role === "admin"; });
  }

  function accountRows() {
    return db.users.filter(function (row) { return row.role === "user"; });
  }

  function log(kind, username) {
    var meta = clientMeta();
    db.events.unshift({
      id: uid(), kind: kind, username: username || null,
      ip: meta.ip, user_agent: meta.userAgent, created_at: nowIso()
    });
    if (db.events.length > 2000) db.events.length = 2000;
  }

  function clientMeta() {
    var ua = "";
    try { ua = String(navigator.userAgent || "").slice(0, 28); } catch (e) {}
    return { ip: "本机演示", userAgent: ua };
  }

  function requireAdmin() {
    var row = db.me.admin ? findById(db.me.admin) : null;
    if (!row || row.role !== "admin") return fail("login_required", 401);
    return row;
  }

  function dayKey(iso) {
    var t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t + 8 * HOUR).toISOString().slice(0, 10) : "";
  }

  function overview() {
    var now = Date.now();
    var accounts = accountRows(), adminRows = admins();
    var byKind = function (list, kind) {
      return list.filter(function (row) { return row.kind === kind; }).length;
    };
    var recent = db.events.filter(function (row) {
      var t = Date.parse(row.created_at);
      return Number.isFinite(t) && now - t < DAY;
    });
    var days = [];
    for (var index = 6; index >= 0; index -= 1) {
      var key = new Date(now - index * DAY + 8 * HOUR).toISOString().slice(0, 10);
      var inDay = db.events.filter(function (row) { return dayKey(row.created_at) === key; });
      days.push({ date: key, account: byKind(inDay, "account"), guest: byKind(inDay, "guest"), admin: byKind(inDay, "admin") });
    }
    var top = accounts.slice().sort(function (a, b) {
      return (Date.parse(b.last_login_at || "") || 0) - (Date.parse(a.last_login_at || "") || 0);
    }).slice(0, 5).map(function (row) {
      return {
        username: row.username, role_label: row.display_name,
        last_login_at: row.last_login_at || null, login_count: row.login_count || 0
      };
    });
    return {
      generated_at: new Date(now).toISOString(),
      window_hours: 24,
      list_bound: LIST_BOUND,
      totals: {
        accounts: accounts.length,
        admins: adminRows.length,
        guests: db.guests.length,
        active_accounts_7d: accounts.filter(function (row) {
          var t = Date.parse(row.last_login_at || "");
          return Number.isFinite(t) && now - t < 7 * DAY;
        }).length
      },
      last_24h: {
        account_logins: byKind(recent, "account"),
        guest_visits: byKind(recent, "guest"),
        admin_logins: byKind(recent, "admin")
      },
      days: days,
      top_logins: top
    };
  }

  function dispatch(path, body) {
    if (path === "/api/health") return ok({ ok: true, service: "xinli-ligand-auth-demo", demo: true });
    if (path === "/api/admin/status") return ok({ seeded: admins().length > 0 });

    if (path === "/api/session") {
      var current = db.me.user ? findById(db.me.user) : null;
      return ok({ user: current ? publicUser(current) : null, guest: !!db.me.guest });
    }

    if (path === "/api/guest") {
      if (!db.me.guest || !guestAlive(db.me.guest)) {
        var row = { id: uid(), created_at: nowIso(), last_seen_at: nowIso() };
        db.guests.push(row);
        if (db.guests.length > LIST_BOUND) db.guests.shift();
        db.me.guest = row.id;
        log("guest", null);
      }
      save();
      return { status: 201, data: { ok: true, demo: true } };
    }

    if (path === "/api/register") {
      var name = canonicalUsername(body.username);
      if (name.__fail) return failOf(name);
      var pw = checkPassword(body.password, USER_MIN);
      if (pw.__fail) return failOf(pw);
      var label = checkLabel(body.role_label);
      if (label.__fail) return failOf(label);
      if (find(name)) return failOf(fail("username_taken", 409));
      var salt = randHex(16);
      var created = {
        id: uid(), username: name, role: "user", display_name: label,
        salt: salt, hash: derive(pw, salt),
        created_at: nowIso(), last_login_at: nowIso(), login_count: 1
      };
      db.users.push(created);
      db.me.user = created.id;
      db.me.guest = null;
      log("account", name);
      save();
      return { status: 201, data: { user: publicUser(created), demo: true } };
    }

    if (path === "/api/login") {
      var loginName = canonicalUsername(body.username);
      if (loginName.__fail) return failOf(loginName);
      var loginPw = checkLoginPassword(body.password);
      if (loginPw.__fail) return failOf(loginPw);
      var found = find(loginName);
      // 与生产一致：主页面登录不区分角色，管理员账号也能从主页面进入。
      if (!found || derive(loginPw, found.salt) !== found.hash) {
        return failOf(fail("invalid_credentials", 401));
      }
      found.last_login_at = nowIso();
      found.login_count = (found.login_count || 0) + 1;
      db.me.user = found.id;
      db.me.guest = null;
      log("account", found.username);
      save();
      return ok({ user: publicUser(found), demo: true });
    }

    if (path === "/api/logout") {
      db.me.user = null;
      save();
      return ok({ ok: true, demo: true });
    }

    if (path === "/api/admin/setup") {
      if (admins().length > 0) return failOf(fail("already_seeded", 409));
      var adminName = canonicalUsername(body.username);
      if (adminName.__fail) return failOf(adminName);
      var adminPw = checkPassword(body.password, ADMIN_MIN);
      if (adminPw.__fail) return failOf(adminPw);
      if (find(adminName)) return failOf(fail("username_taken", 409));
      var adminSalt = randHex(16);
      var admin = {
        id: uid(), username: adminName, role: "admin", display_name: "管理员",
        salt: adminSalt, hash: derive(adminPw, adminSalt),
        created_at: nowIso(), last_login_at: nowIso(), login_count: 1
      };
      db.users.push(admin);
      db.me.admin = admin.id;
      log("admin_setup", admin.username);
      save();
      return { status: 201, data: { user: publicUser(admin), demo: true } };
    }

    if (path === "/api/admin/login") {
      var target = canonicalUsername(body.username);
      if (target.__fail) return failOf(target);
      var targetPw = checkLoginPassword(body.password);
      if (targetPw.__fail) return failOf(targetPw);
      var hit = find(target);
      if (!hit || hit.role !== "admin" || derive(targetPw, hit.salt) !== hit.hash) {
        return failOf(fail("invalid_credentials", 401));
      }
      hit.last_login_at = nowIso();
      hit.login_count = (hit.login_count || 0) + 1;
      db.me.admin = hit.id;
      log("admin", hit.username);
      save();
      return ok({ user: publicUser(hit), demo: true });
    }

    if (path === "/api/admin/logout") {
      db.me.admin = null;
      save();
      return ok({ ok: true, demo: true });
    }

    if (path === "/api/admin/overview") {
      var adminRow = requireAdmin();
      if (adminRow.__fail) return failOf(adminRow);
      return ok(overview());
    }

    if (path === "/api/admin/users") {
      var adminRow2 = requireAdmin();
      if (adminRow2.__fail) return failOf(adminRow2);
      var items = db.users.slice().sort(function (a, b) {
        return (Date.parse(b.last_login_at || "") || 0) - (Date.parse(a.last_login_at || "") || 0);
      }).slice(0, PAGE_LIMIT).map(function (row) {
        var pub = publicUser(row);
        pub.id = row.id;
        return pub;
      });
      return ok({ list_bound: LIST_BOUND, page_limit: PAGE_LIMIT, items: items });
    }

    if (path === "/api/admin/events") {
      var adminRow3 = requireAdmin();
      if (adminRow3.__fail) return failOf(adminRow3);
      return ok({
        list_bound: LIST_BOUND, page_limit: PAGE_LIMIT,
        items: db.events.slice(0, PAGE_LIMIT)
      });
    }

    return failOf(fail("not_found", 404));
  }

  function guestAlive(id) {
    for (var i = 0; i < db.guests.length; i++) if (db.guests[i].id === id) return true;
    return false;
  }

  function ok(data) { return { status: 200, data: data }; }
  function failOf(error) { return { status: error.status, data: { error: error.code } }; }

  // CSV 构建：UTF-8 BOM + RFC 4180 转义 + 公式注入防护，与后端 functions/export.mjs 保持一致。
  function escapeCell(value) {
    if (value === null || value === undefined) return "";
    var str = String(value);
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    if (/[",\r\n]/.test(str)) str = '"' + str.replace(/"/g, '""') + '"';
    return str;
  }

  function buildCsv(rows, columns) {
    var lines = [columns.join(",")];
    for (var i = 0; i < rows.length; i++) {
      var cells = [];
      for (var j = 0; j < columns.length; j++) cells.push(escapeCell(rows[i][columns[j]]));
      lines.push(cells.join(","));
    }
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }

  var EXPORT_KINDS = {
    events: { table: "login_events", columns: ["id", "kind", "username", "ip", "user_agent", "created_at"], source: function () { return db.events; } },
    users: { table: "users", columns: ["id", "username", "role", "display_name", "created_at", "last_login_at", "login_count"], source: function () { return db.users; } },
    guests: { table: "guests", columns: ["id", "created_at", "last_seen_at"], source: function () { return db.guests; } }
  };

  window.demoExport = function (kind) {
    if (!db) db = load();
    var spec = EXPORT_KINDS[kind];
    if (!spec) return "";
    return buildCsv(spec.source(), spec.columns);
  };

  function handle(path, body) {
    var result = dispatch(path, body || {});
    paint();
    return Promise.resolve(result);
  }

  /* ===== 横幅：把「这是演示数据」写在页面最上面，不靠脚注 ===== */

  function isAdminPage() {
    return /admin/i.test(location.pathname);
  }

  var bar = null;

  function paint() {
    if (!bar) return;
    bar.querySelector("[data-demo-count]").textContent =
      accountRows().length + " 个账号 · " + db.guests.length + " 个游客会话 · " + db.events.length + " 条进入记录";
    var notice = bar.querySelector("[data-demo-sample]");
    notice.hidden = !db.samples;
    notice.textContent = "已灌入示例记录：用户名都带 demo_ 前缀，是造出来的演示数据，不是真实访客。";
    var seed = bar.querySelector('[data-demo-act="seed"]');
    if (seed) {
      seed.disabled = db.samples;
      seed.textContent = db.samples ? "示例记录已灌入（每个浏览器只一次）" : "灌入示例访问记录";
      seed.setAttribute("style", buttonStyle(db.samples));
    }
  }

  function buttonStyle(disabled) {
    return "border:1px solid #C9A96A;background:#fff;color:#5C4A16;border-radius:8px;padding:6px 10px;"
      + "font:inherit;font-size:12px;cursor:" + (disabled ? "default;opacity:.55" : "pointer");
  }

  function banner() {
    if (bar) return;
    bar = document.createElement("div");
    bar.setAttribute("style",
      "background:#FFF6E5;border-bottom:1px solid #E8D7AE;color:#5C4A16;" +
      "padding:9px 14px;font-size:12px;line-height:1.55;");
    bar.innerHTML =
      '<div style="max-width:820px;margin:0 auto">' +
      '<b>演示模式</b> · 这份副本没有连服务器，注册与访问记录只保存在当前浏览器（localStorage），关闭浏览器数据仍在，换设备看不到。' +
      '真实后端版本部署在站点 Function + PostgreSQL 上。<b style="color:#8a5a06">请勿输入你正在使用的真实密码。</b>' +
      '<div data-demo-count style="margin-top:4px"></div>' +
      '<div data-demo-sample style="margin-top:4px;color:#8a5a06;font-weight:700" hidden></div>' +
      '<div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">' +
      (isAdminPage() ? '<button data-demo-act="seed" style="' + buttonStyle(false) + '">灌入示例访问记录</button>' : "") +
      '<button data-demo-act="reset" style="' + buttonStyle(false) + '">清空本机演示数据</button>' +
      '</div></div>';
    document.body.insertBefore(bar, document.body.firstChild);
    bar.addEventListener("click", function (event) {
      var button = event.target.closest ? event.target.closest("[data-demo-act]") : null;
      if (!button) return;
      var act = button.getAttribute("data-demo-act");
      if (act === "reset") {
        db = fresh();
        save();
        location.reload();
        return;
      }
      if (act === "seed") {
        seedSamples();
        save();
        paint();
      }
    });
    paint();
  }

  // 示例记录：用户名一律带 demo_ 前缀，配合横幅上的「非真实访客」说明，避免被当成真实流量。
  function seedSamples() {
    if (db.samples) return;
    var labels = ["家长", "老师", "教练", "家长", "其它"];
    var names = ["demo_jiazhang01", "demo_laoshi02", "demo_jiaolian03", "demo_mama14", "demo_qita05"];
    for (var i = 0; i < names.length; i++) {
      if (find(names[i])) continue;
      var salt = randHex(16);
      db.users.push({
        id: uid(), username: names[i], role: "user", display_name: labels[i],
        salt: salt, hash: derive("demo-sample-" + names[i], salt),
        created_at: new Date(Date.now() - (i + 2) * DAY).toISOString(),
        last_login_at: new Date(Date.now() - i * 20 * HOUR).toISOString(),
        login_count: 2 + i
      });
    }
    for (var g = 0; g < 4; g++) {
      var stamp = new Date(Date.now() - g * 14 * HOUR).toISOString();
      db.guests.push({ id: uid(), created_at: stamp, last_seen_at: stamp });
    }
    var kinds = ["account", "guest", "guest", "account", "admin", "guest", "account", "guest"];
    for (var d = 0; d < 7; d++) {
      for (var k = 0; k < kinds.length; k++) {
        if ((d + k) % 3 === 0) continue;
        var kind = kinds[k];
        var when = new Date(Date.now() - d * DAY - k * 90 * 60000).toISOString();
        db.events.push({
          id: uid(), kind: kind,
          username: kind === "account" ? names[(d + k) % names.length] : (kind === "admin" ? (db.me.admin ? findById(db.me.admin).username : "admin") : null),
          ip: "本机演示", user_agent: "示例数据", created_at: when
        });
      }
    }
    db.events.sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); });
    db.samples = true;
  }

  window.demoHit = function (path, body) {
    window.demoHit.active = true;
    if (!db) db = load();
    banner();
    return handle(path, body);
  };
})();
