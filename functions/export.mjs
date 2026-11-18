// CSV 导出：UTF-8 BOM + RFC 4180 转义 + CSV 注入防护。
// 只用于管理员后台，requireAdmin 在调用方已经做过。

// RFC 4180：字段含逗号、双引号、换行时，用双引号包裹，内部双引号翻倍。
function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // CSV 注入防护：以 = + - @ 或制表符/回车开头的值，前面加单引号，让 Excel 当文本。
  if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
  if (/[",\r\n]/.test(str)) {
    str = '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export function buildCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    const cells = columns.map(col => escapeCell(row[col]));
    lines.push(cells.join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
