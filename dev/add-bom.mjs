// 给导出文件加 UTF-8 BOM：中文 Windows 的 Excel 双击打开 CSV/TXT 时，
// 没有 BOM 会把 UTF-8 中文按 GBK 解析成乱码。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(import.meta.dirname, '..', '真实数据导出');
for (const name of ['login_events.csv', 'users.csv', 'guests.csv', '字段说明.txt']) {
  const file = resolve(dir, name);
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.charCodeAt(0) === 0xFEFF ? text : '\uFEFF' + text, 'utf8');
  console.log(`${name}: BOM ok`);
}
