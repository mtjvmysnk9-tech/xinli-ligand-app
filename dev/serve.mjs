// 本地演练服务器：静态页面 + 真实 functions/ 模块 + 凭据无关的假数据库。
// 只用于部署前的交互检查，不属于任何上传目录，也不会打进 Function 包。
// XINLI_ROOT=提交包 换服务目录；XINLI_NO_API=1 模拟「只有静态文件、没有后端」的托管。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../functions/router.mjs';
import { createFakeDb } from './fake-db.mjs';

const root = fileURLToPath(new URL(`../${process.env.XINLI_ROOT || 'dist'}/`, import.meta.url));
const port = Number(process.argv[2] || 8123);
const serveApi = process.env.XINLI_NO_API !== '1';
const origin = `http://127.0.0.1:${port}`;
const db = createFakeDb({ mode: 'ok', writes: [] });
const handle = createApplication({ db, origin });
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url, origin);
  try {
    if (serveApi && url.pathname.startsWith('/functions/v1/app')) {
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 65536) { outgoing.writeHead(413, { 'content-type': 'application/json' }); outgoing.end('{"error":"payload_too_large"}'); return; }
        chunks.push(chunk);
      }
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        ...(size && !['GET', 'HEAD'].includes(incoming.method) ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await handle({ request, requestId: 'local-preview' });
      // Object.fromEntries 会把多个 set-cookie 合并成一条逗号串（浏览器会拒收），必须按数组透传。
      const headers = { ...Object.fromEntries(response.headers), 'cache-control': 'no-store' };
      delete headers['set-cookie'];
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
      outgoing.writeHead(response.status, headers);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
      console.log(`${incoming.method} ${url.pathname} -> ${response.status}`);
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const file = join(root, rel || 'index.html');
    if (!file.startsWith(root)) throw new Error('outside root');
    const bytes = await readFile(file);
    outgoing.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    outgoing.end(bytes);
  } catch (error) {
    outgoing.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    outgoing.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`本地演练：${origin}`));
