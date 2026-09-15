// 认证：密码哈希、签名 cookie、登录限速。
//
// 登录态是无状态的 HMAC 签名 cookie，签名密钥落盘（data/secret.key），
// 所以服务重启后同事不会被踢出去。
import { scrypt, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { loadSecret } from "./store.js";

// maxmem 必须显式给：scrypt 内存 = 128*N*r，默认上限 32MB，
// 哪天调大 N 就会直接抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const COOKIE = "zdy";
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const RENEW_WHEN_BELOW = 25 * 24 * 3600 * 1000; // 剩余少于 25 天时续期

let SECRET = null;
export async function initAuth() {
  SECRET = await loadSecret();
}

// ---------- 密码 ----------

// 用异步 scrypt，不用 scryptSync —— 同步版会阻塞事件循环约 100ms，
// 而所有客户端正在每 1.2 秒轮询，登录瞬间会全员一起卡。
const scryptAsync = (pw, salt) =>
  new Promise((res, rej) =>
    scrypt(pw, salt, 64, PARAMS, (e, k) => (e ? rej(e) : res(k))),
  );

// 做 NFKC 归一化（中文输入法下的全角字符不该导致登录失败），但不 trim
// —— 首尾空格是密码的一部分，静默 trim 会让注册和登录行为不一致。
const norm = (pw) => String(pw ?? "").normalize("NFKC");

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scryptAsync(norm(pw), salt);
  return {
    algo: "scrypt",
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    salt: salt.toString("hex"),
    hash: key.toString("hex"),
  };
}

export async function verifyPassword(pw, rec) {
  if (!rec?.salt || !rec?.hash) return false;
  try {
    const key = await scryptAsync(norm(pw), Buffer.from(rec.salt, "hex"));
    const want = Buffer.from(rec.hash, "hex");
    return key.length === want.length && timingSafeEqual(key, want);
  } catch {
    return false;
  }
}

// ---------- 登录态 ----------

const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");

export function signToken({ u, v, iat, exp }) {
  const body = b64u(JSON.stringify({ u, v, iat, exp }));
  const sig = b64u(createHmac("sha256", SECRET).update(body).digest());
  return `${body}.${sig}`;
}

/** 校验签名与有效期。通过返回 payload，否则 null。 */
export function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = createHmac("sha256", SECRET).update(body).digest();

  let got;
  try {
    got = fromB64u(sig);
  } catch {
    return null;
  }
  // 长度不等时 timingSafeEqual 会抛，先挡掉
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;

  let payload;
  try {
    payload = JSON.parse(fromB64u(body).toString("utf-8"));
  } catch {
    return null;
  }
  if (!payload?.u || !payload?.exp || payload.exp < Date.now()) return null;
  return payload;
}

export function issueCookie(user, prev) {
  const now = Date.now();
  const fresh = {
    u: user.key,
    v: user.tokenVersion || 1,
    iat: now,
    exp: now + MAX_AGE_MS,
  };
  // 滑动续期：只在快到期时重发，避免每个请求都 Set-Cookie
  if (prev && prev.exp - now > RENEW_WHEN_BELOW) return null;
  return `${COOKIE}=${signToken(fresh)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}`;
}

// 内网是 http，绝不能加 Secure —— 浏览器会静默丢弃这个 cookie，
// 表现为「登录成功但下一刻又是未登录」，极难排查。
export const clearCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function readToken(req) {
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// ---------- 登录限速（内存，重启清零，内网够用） ----------

const attempts = new Map(); // nameKey -> { n, until }
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

/** 返回剩余锁定毫秒数，0 表示可以尝试 */
export function lockedFor(nameKey) {
  const a = attempts.get(nameKey);
  if (!a || !a.until) return 0;
  const left = a.until - Date.now();
  if (left <= 0) {
    attempts.delete(nameKey);
    return 0;
  }
  return left;
}

export function noteFailure(nameKey) {
  const a = attempts.get(nameKey) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= MAX_FAILS) {
    a.until = Date.now() + LOCK_MS;
    a.n = 0; // 锁一次后重新计数
  }
  attempts.set(nameKey, a);
}

export const noteSuccess = (nameKey) => attempts.delete(nameKey);
