// 语法自检：把页面内联 <script> 取出来交给解析器，不执行任何页面代码。
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
let bad = 0;
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!blocks.length) { console.log(`SKIP ${file}：没有内联脚本`); continue; }
  blocks.forEach((match, index) => {
    try {
      new Function(match[1]);
      console.log(`OK   ${file} 第 ${index + 1} 段脚本（${match[1].length} 字符）`);
    } catch (error) {
      bad += 1;
      console.log(`FAIL ${file} 第 ${index + 1} 段：${error.message}`);
    }
  });
}
process.exit(bad ? 1 : 0);
