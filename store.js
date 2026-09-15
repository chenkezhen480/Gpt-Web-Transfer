// 存储层：用户、会话、消息、通知日志。
//
// 两个关键设计：
//  - 用户目录用服务端生成的不透明 userKey（u_xxxx），用户名只存在 users.json 里。
//    绝不能拿用户名拼路径 —— 中文名会被过滤成空串导致所有人互相覆盖，
//    且 "a-b" 与 "ab" 会撞到同一个文件。
//  - 消息用 JSONL 追加写。聊天记录只增不改，appendFile 是 O(1) 且天然无
//    读-改-写竞态；崩了最多坏最后一行，解析时跳过即可。
import { mkdir, readFile, writeFile, rename, appendFile, rm } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";

const DATA = path.join(import.meta.dirname, "data");
const USERS_FILE = path.join(DATA, "users.json");
const SECRET_FILE = path.join(DATA, "secret.key");
const NOTICES_FILE = path.join(DATA, "notices.json");
const USERS_DIR = path.join(DATA, "users");

const userDir = (key) => path.join(USERS_DIR, key);
const sessionsFile = (key) => path.join(userDir(key), "sessions.json");
const messagesDir = (key) => path.join(userDir(key), "messages");
const messagesFile = (key, sid) => path.join(messagesDir(key), sid + ".jsonl");

// 只接受服务端生成的形状，杜绝路径穿越。任何来自 URL 的 id 必须先过这里。
const KEY_RE = /^u_[0-9a-f]{16}$/;
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isValidKey = (k) => KEY_RE.test(String(k || ""));
export const isValidSid = (s) => SID_RE.test(String(s || ""));

const MAX_NOTICES = 50;
export const MAX_TITLE = 20;

// 同一个文件上的写入排成一队。
//
// writeAtomic 是"先写临时文件再改名"，两个并发写会撞在一起：临时名过去只带 pid，
// 两次写用的是同一个临时名；而且改名还可能撞上对方正打开的目标文件 ——
// 实测在 Windows 上是 EPERM。这本身只是个报错，但调用链上没人接住它，
// 于是变成 unhandled rejection，**整个进程被打挂**，全员断线。
// 排队之后，同一个文件的改名永远不会互相踩。
const writeQueue = new Map();

function writeAtomic(file, text) {
  const prev = writeQueue.get(file) || Promise.resolve();
  // 前一次成功与否都要接着往下走，否则一次失败会把这个文件的后续写入全卡死
  const next = prev.then(
    () => atomicWrite(file, text),
    () => atomicWrite(file, text),
  );
  writeQueue.set(
    file,
    next.catch(() => {}),
  );
  return next;
}

async function atomicWrite(file, text) {
  // 临时名再带一段随机后缀：即使同时跑了两份服务（不同进程）也不会撞
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text, "utf-8");
  // Windows 上目标文件偶尔被杀毒或索引短暂占住，改名会报 EPERM —— 退一步重试
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, file);
      return;
    } catch (e) {
      const transient = e.code === "EPERM" || e.code === "EACCES" || e.code === "EBUSY";
      if (!transient || i >= 3) {
        await rm(tmp, { force: true }).catch(() => {}); // 别留一地临时文件
        throw e;
      }
      await new Promise((r) => setTimeout(r, 30 * (i + 1)));
    }
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return fallback; // 不存在或损坏，都当空
  }
}

export async function init() {
  await mkdir(USERS_DIR, { recursive: true });
}

// ---------- 签名密钥 ----------

// 落盘而不是放内存：否则每次重启全员掉线
export async function loadSecret() {
  try {
    const s = await readFile(SECRET_FILE);
    if (s.length >= 32) return s;
  } catch {
    /* 首次运行，往下生成 */
  }
  const s = randomBytes(32);
  await writeFile(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

// ---------- 用户 ----------

let users = new Map(); // userKey -> 用户对象；常驻内存，每请求鉴权不碰磁盘

/** 唯一性判定与查找键：NFKC 抹平全角/半角，小写抹平英文大小写 */
export const nameKeyOf = (name) =>
  String(name || "").normalize("NFKC").trim().toLowerCase();

/** 用户名校验。返回错误文案，通过则返回 null。 */
export function validateName(name) {
  const raw = String(name || "");
  if (raw !== raw.trim()) return "账号首尾不能有空格";
  const k = nameKeyOf(raw);
  if (k.length < 1) return "账号不能为空";
  if (k.length > 32) return "账号最长 32 个字符";
  // 控制字符与零宽字符。用转义写，绝不把不可见字符嵌进源码
  if (/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/.test(raw)) {
    return "账号不能包含控制字符或零宽字符";
  }
  return null;
}

export async function initUsers() {
  const data = await readJson(USERS_FILE, { version: 1, users: {} });
  users = new Map(Object.entries(data.users || {}));
}

export const getUserByKey = (key) => (isValidKey(key) ? users.get(key) : undefined);

export function findUserByName(name) {
  const k = nameKeyOf(name);
  for (const u of users.values()) if (u.nameKey === k) return u;
  return null;
}

export async function saveUsers() {
  await writeAtomic(
    USERS_FILE,
    JSON.stringify({ version: 1, users: Object.fromEntries(users) }, null, 2),
  );
}

export async function createUser(name, pwd) {
  const key = "u_" + randomBytes(8).toString("hex");
  const user = {
    key,
    name: String(name),
    nameKey: nameKeyOf(name),
    pwd,
    createdAt: Date.now(),
    tokenVersion: 1,
  };
  users.set(key, user);
  await mkdir(messagesDir(key), { recursive: true });
  await saveUsers();
  return user;
}

// 改密会把 tokenVersion 加一，立即作废所有已发出的登录态
export async function setPassword(key, pwd) {
  const u = users.get(key);
  if (!u) return null;
  u.pwd = pwd;
  u.tokenVersion = (u.tokenVersion || 1) + 1;
  await saveUsers();
  return u;
}

// ---------- 会话 ----------

export async function listSessions(key) {
  if (!isValidKey(key)) return [];
  const data = await readJson(sessionsFile(key), { version: 1, sessions: {} });
  return Object.values(data.sessions || {}).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getSession(key, sid) {
  if (!isValidKey(key) || !isValidSid(sid)) return null;
  const data = await readJson(sessionsFile(key), { version: 1, sessions: {} });
  return data.sessions?.[sid] || null;
}

async function writeSessions(key, sessions) {
  await mkdir(userDir(key), { recursive: true });
  await writeAtomic(
    sessionsFile(key),
    JSON.stringify({ version: 1, sessions }, null, 2),
  );
}

async function mutateSession(key, sid, fn) {
  if (!isValidKey(key) || !isValidSid(sid)) return null;
  const data = await readJson(sessionsFile(key), { version: 1, sessions: {} });
  const sessions = data.sessions || {};
  const s = sessions[sid];
  if (!s) return null;
  const out = fn(s) || s;
  await writeSessions(key, sessions);
  return out;
}

export async function createSession(key, title = "") {
  const sid = randomUUID();
  const now = Date.now();
  const session = {
    id: sid,
    title,
    titleLocked: false,
    chatUrl: null, // 尚未在 ChatGPT 侧建立对话
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    pending: false, // 末条是 user 且未回复 → 有一条在飞
  };
  const data = await readJson(sessionsFile(key), { version: 1, sessions: {} });
  data.sessions = data.sessions || {};
  data.sessions[sid] = session;
  await writeSessions(key, data.sessions);
  await mkdir(messagesDir(key), { recursive: true });
  return session;
}

export const updateSession = (key, sid, patch) =>
  mutateSession(key, sid, (s) => Object.assign(s, patch, { updatedAt: Date.now() }));

/** 首条用户消息生成标题。按码点截断，否则 emoji 会被切成半个字符。 */
export function titleFrom(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  const chars = Array.from(t);
  return chars.length > MAX_TITLE ? chars.slice(0, MAX_TITLE).join("") + "…" : t;
}

/** 改标题上锁，之后不再被首条消息自动覆盖 */
export const renameSession = (key, sid, title) =>
  mutateSession(key, sid, (s) => {
    s.title = String(title).slice(0, 60);
    s.titleLocked = true;
  });

export async function deleteSession(key, sid) {
  if (!isValidKey(key) || !isValidSid(sid)) return false;
  const data = await readJson(sessionsFile(key), { version: 1, sessions: {} });
  if (!data.sessions?.[sid]) return false;
  delete data.sessions[sid];
  await writeSessions(key, data.sessions);
  await writeAtomic(messagesFile(key, sid), ""); // 清空内容但保留文件，便于排查
  await clearAssets(key, sid);
  return true;
}

// ---------- 消息（JSONL 追加） ----------

/** 追加一条消息。返回落定的消息对象（调用方要用它做 SSE 推送）。 */
export async function appendMessage(key, sid, msg) {
  if (!isValidKey(key) || !isValidSid(sid)) return null;
  await mkdir(messagesDir(key), { recursive: true });
  await appendFile(messagesFile(key, sid), JSON.stringify(msg) + "\n", "utf-8");
  await mutateSession(key, sid, (s) => {
    s.messageCount = (s.messageCount || 0) + 1;
    s.pending = msg.role === "user";
  });
  return msg;
}

// ---------- 附件（图片与生成的文件共用一套存储） ----------

// 存盘名由服务端生成，绝不使用原始文件名 —— 那是用户可见的字符串，必须当成不可信输入
const ASSET_RE = /^[0-9a-f]{16}\.[a-z0-9]{1,8}$/;
const EXT_OK = /^[a-z0-9]{1,8}$/;
const assetsDir = (key, sid) => path.join(userDir(key), "assets", sid);

/** 存一份附件，返回存盘名。ext 由 content-type 或原文件名推得。 */
export async function saveAsset(key, sid, buf, ext = "bin") {
  if (!isValidKey(key) || !isValidSid(sid)) return null;
  let e = String(ext || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!EXT_OK.test(e)) e = "bin";
  const name = randomBytes(8).toString("hex") + "." + e;
  const dir = assetsDir(key, sid);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), buf);
  return name;
}

/** 取附件的绝对路径；名字不合格返回 null（防路径穿越） */
export function assetFile(key, sid, name) {
  if (!isValidKey(key) || !isValidSid(sid) || !ASSET_RE.test(String(name || ""))) {
    return null;
  }
  return path.join(assetsDir(key, sid), name);
}

export async function clearAssets(key, sid) {
  if (!isValidKey(key) || !isValidSid(sid)) return;
  await rm(assetsDir(key, sid), { recursive: true, force: true });
}

/** 清空某个会话的消息，但保留会话本身（标题、chatUrl 绑定都不动） */
export async function clearMessages(key, sid) {
  if (!isValidKey(key) || !isValidSid(sid)) return false;
  await writeAtomic(messagesFile(key, sid), "");
  await mutateSession(key, sid, (s) => {
    s.messageCount = 0;
    s.pending = false;
  });
  return true;
}

/** 所有用户，启动自愈时用 */
export const allUsers = () => [...users.values()];

/** 读整个会话；since 之后的部分由调用方切。坏行跳过。 */
export async function readMessages(key, sid) {
  if (!isValidKey(key) || !isValidSid(sid)) return [];
  let raw;
  try {
    raw = await readFile(messagesFile(key, sid), "utf-8");
  } catch {
    return []; // 会话还没有任何消息
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 崩溃残留的半行，跳过 */
    }
  }
  return out;
}

// ---------- 开发者日志（按日期分文件） ----------

const LOGS_DIR = path.join(DATA, "logs");

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const localTime = (d = new Date()) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

/**
 * 记一条给开发者看的日志：data/logs/<日期>.log，一天一个文件，追加写。
 *
 * 用途主要是「中转里的会话删了，但 ChatGPT 那边没删掉」这类需要人工去项目里
 * 善后的事 —— 站内通知面板是给全体同事看故障的，这类事塞进去只会是噪音。
 */
export async function logForDeveloper(title, fields = {}) {
  try {
    await mkdir(LOGS_DIR, { recursive: true });
    const now = new Date();
    const lines = [`[${localDate(now)} ${localTime(now)}] ${title}`];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === "") continue;
      lines.push(`  ${k}：${v}`);
    }
    lines.push("");
    await appendFile(path.join(LOGS_DIR, `${localDate(now)}.log`), lines.join("\n") + "\n", "utf-8");
    return true;
  } catch (e) {
    // 写日志失败绝不能影响主流程
    console.warn("[日志] 写入失败:", e.message);
    return false;
  }
}

// ---------- 用户反馈 ----------

const FEEDBACK_DIR = path.join(DATA, "feedback");

/**
 * 同事在维护消息面板点了"反馈"，把当时那条维护消息原样存档。
 * 和开发者日志分开：那边是系统自己的故障，这边是人的反馈，找起来目的不同。
 */
export async function saveFeedback(who, snapshot) {
  try {
    await mkdir(FEEDBACK_DIR, { recursive: true });
    const now = new Date();
    const lines = [`[${localDate(now)} ${localTime(now)}] 用户「${who}」反馈了维护消息`];

    const s = snapshot.current || {};
    lines.push(`  当时状态：${s.state || "(未知)"}`);
    if (s.detail) lines.push(`  状态说明：${s.detail}`);
    if (s.steps?.length) {
      lines.push("  页面给出的排查步骤：");
      for (const st of s.steps) lines.push(`    - ${st}`);
    }
    if (snapshot.events?.length) {
      lines.push("  面板上的事件记录：");
      for (const e of snapshot.events) {
        const t = new Date(e.ts);
        lines.push(`    ${localTime(t)} [${e.level}] ${e.text}`);
      }
    }
    lines.push("");

    await appendFile(
      path.join(FEEDBACK_DIR, `${localDate(now)}.log`),
      lines.join("\n") + "\n",
      "utf-8",
    );
    return true;
  } catch (e) {
    console.warn("[反馈] 写入失败:", e.message);
    return false;
  }
}

// ---------- 通知日志（全体共享） ----------

export async function loadNotices() {
  const data = await readJson(NOTICES_FILE, { version: 1, rev: 0, events: [] });
  return { rev: data.rev || 0, events: data.events || [] };
}

/** 状态变化时追加一条。相同内容相邻重复则跳过，避免刷屏。 */
export async function addNotice(level, text) {
  const data = await readJson(NOTICES_FILE, { version: 1, rev: 0, events: [] });
  const events = data.events || [];
  const last = events[events.length - 1];
  if (last && last.text === text && last.level === level) return data.rev || 0;

  events.push({ ts: Date.now(), level, text });
  const trimmed = events.slice(-MAX_NOTICES);
  const rev = (data.rev || 0) + 1;
  await writeAtomic(NOTICES_FILE, JSON.stringify({ version: 1, rev, events: trimmed }, null, 2));
  return rev;
}
