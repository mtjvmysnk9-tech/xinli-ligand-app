// 站点固定公开来源与 Cookie 名称。来源必须是完整 HTTPS origin（无末尾斜杠）。
export const SITE_ORIGIN = 'https://xinli-ligand-t3tamdheczu.qoder.zone';

export const SESSION_COOKIE = '__Host-app_auth.session';
export const ADMIN_COOKIE = '__Host-app_auth.admin';
export const GUEST_COOKIE = '__Host-app_auth.guest';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const USER_PASSWORD_MIN_CHARS = 10;
export const ADMIN_PASSWORD_MIN_CHARS = 15;
