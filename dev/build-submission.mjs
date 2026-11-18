// 从 dist/ 生成「比赛提交包」：无平台角标、可在本地双击打开的自包含副本。
// 做法是把 dev/demo-shim.js 注入页面，并把 api() 改成「后端不可达时走本机演示」。
// dist/ 本身保持不变，Sites 生产副本仍然只打真实后端。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, '提交包');
const shim = readFileSync(resolve(root, 'dev', 'demo-shim.js'), 'utf8');

const ORIGINAL_API = [
  '  return fetch(API + path, init).then(function (r) {',
  '    return r.json().then(function (d) { return { status:r.status, data:d }; }, function () { return { status:r.status, data:null }; });',
  '  });',
].join('\n');

const DEMO_API = [
  '  if (window.demoHit && window.demoHit.active) return window.demoHit(path, body);',
  '  var request;',
  '  try { request = fetch(API + path, init); } catch (error) { return window.demoHit(path, body); }',
  '  return request.then(function (r) {',
  '    return r.json().then(function (d) {',
  '      // 返回体不是 JSON 对象 = 这里没有站点 Function（本地文件或静态托管），切本机演示。',
  '      if (d === null || typeof d !== "object") return window.demoHit(path, body);',
  '      return { status:r.status, data:d };',
  '    }, function () { return window.demoHit(path, body); });',
  '  }, function () { return window.demoHit(path, body); });',
].join('\n');

const shimTag = `<script>\n/* 本机演示后端（由 dev/build-submission.mjs 注入，非真实服务） */\n${shim}\n</script>\n`;

function build(name) {
  const source = readFileSync(resolve(root, 'dist', name), 'utf8');
  if (!source.includes(ORIGINAL_API)) throw new Error(`${name}: 没有匹配到 api() 的 fetch 段`);
  const scripts = source.split('<script>');
  if (scripts.length !== 2) throw new Error(`${name}: 期望恰好一个 <script> 段，实际 ${scripts.length - 1} 个`);
  const patched = source.replace(ORIGINAL_API, DEMO_API);
  const withShim = patched.replace('<script>', `${shimTag}<script>`);
  writeFileSync(resolve(outDir, name), withShim, 'utf8');
  return withShim.length;
}

mkdirSync(outDir, { recursive: true });
for (const name of ['index.html', 'admin.html']) {
  const size = build(name);
  console.log(`${name} -> 提交包/${name} (${size} 字符)`);
}
