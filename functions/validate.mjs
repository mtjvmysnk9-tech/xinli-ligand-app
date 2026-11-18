// 输入规范化与有界校验。只做纯函数，不触碰数据库。
import { AppError } from './http.mjs';
import { USER_PASSWORD_MIN_CHARS } from './config.mjs';

export const USERNAME_MIN_CHARS = 3;
export const USERNAME_MAX_CHARS = 32;
export const PASSWORD_MAX_BYTES = 256;

// 规范用户名：去首尾空白 + 转小写后必须匹配严格字符集（只用 ASCII，避免同形字与规范化歧义）。
export function canonicalUsername(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_username', 400);
  const canonical = raw.trim().toLowerCase();
  if (canonical.length < USERNAME_MIN_CHARS || canonical.length > USERNAME_MAX_CHARS) {
    throw new AppError('invalid_username', 400);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(canonical)) throw new AppError('invalid_username', 400);
  return canonical;
}

// 密码只做长度有界校验，绝不记录、绝不回显。长度按码点计，上限按 UTF-8 字节计。
export function validatePassword(raw, minChars) {
  if (typeof raw !== 'string') throw new AppError('invalid_password', 400);
  const floor = Number.isSafeInteger(minChars) ? minChars : USER_PASSWORD_MIN_CHARS;
  if ([...raw].length < floor) throw new AppError('password_too_short', 400);
  if (new TextEncoder().encode(raw).length > PASSWORD_MAX_BYTES) throw new AppError('invalid_password', 400);
  return raw;
}

// 身份标签只接受白名单，杜绝把任意文本写进展示字段。
const ROLE_LABELS = ['家长', '老师', '教练', '其它'];

export function validateRoleLabel(raw) {
  if (raw === undefined || raw === null || raw === '') return '其它';
  if (typeof raw !== 'string') throw new AppError('invalid_input', 400);
  const label = raw.trim();
  if (!ROLE_LABELS.includes(label)) throw new AppError('invalid_input', 400);
  return label;
}

// 登录路径只做上界校验，不使用注册的最小长度：
// 否则「太短」会变成一条与「凭据错误」不同的信号，可用来探测策略。
export function loginPassword(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_credentials', 400);
  if (new TextEncoder().encode(raw).length > PASSWORD_MAX_BYTES) throw new AppError('invalid_credentials', 400);
  return raw;
}
