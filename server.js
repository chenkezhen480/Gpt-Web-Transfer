// 内网中转站服务。Node 内置 http，不引框架。
//
// 鉴权是这一版最容易漏、后果最重的地方：
// 每条 /api/sessions/<sid>/* 都必须校验该 sid 属于当前登录用户，
// 否则任何已登录的同事都能拿别人的 sid 读到**别人的完整历史和 chatUrl**，
// 而 chatUrl 就是能直接打开那个对话的凭据。UUID 不可猜 ≠ 可以不校验。
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import * as store from "./store.js";
import * as auth from "./auth.js";
import * as chatgpt from "./chatgpt.js";
import { config } from "./config.js";

// 本机配置统一走 config.js：config.json 为主，环境变量优先
const cfg = config();
const PORT = cfg.port;
const HOST = cfg.host;
const PUBLIC_DIR = path.join(import.meta.dirname, "public");

// 每人待处理上限：防止一个同事连点把共享浏览器占满
const MAX_PENDING_PER_USER = 3;

// 通知面板底部那行联系方式。来自配置，不写死在代码里 ——
// 没配就不显示这一行（而不是把一个占位的人名摆上去）
const ADMIN_CONTACT = cfg.adminContact;

const STATIC = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  // 生成文件常见的几类。查不到就退回 octet-stream，不影响下载
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  pdf: "application/pdf",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const ERR_TEXT = {
  NO_BROWSER: "连不上你的 Chrome —— 请确认 Chrome 开着且已开启远程调试（见通知面板）",
  NEEDS_LOGIN: "ChatGPT 登录已过期，需要在你自己的 Chrome 里重新登录",
  CHALLENGE: "被 ChatGPT 的风控拦截，需要在你的 Chrome 里人工过一次验证",
  TIMEOUT: "等待回复超时，ChatGPT 那边可能卡住了",
  SELECTOR: "页面上找不到输入框或按钮，ChatGPT 界面可能改版了",
  SESSION_GONE: "这个会话对应的 ChatGPT 对话已打不开（可能被删了或换了账号）",
  NAV: "浏览器通信失败",
};

// 各故障态的排查步骤 —— 直接放进通知面板，同事在站点里就能自救
const STEPS = {
  "no-project": [
    "把 config.json.example 复制成 config.json，填上 CHATGPT_PROJECT_URL",
    "值就是浏览器地址栏里 /project 之前的那一段，例如 https://chatgpt.com/g/g-p-xxxxxxxx-我的项目",
    "填好之后重启服务；这一步只需要做一次",
  ],
  "no-browser": [
    "确认服务器那台机器上的 Chrome 开着（可以最小化，不能退出）",
    "在它的地址栏打开 chrome://inspect/#remote-debugging，确认「允许远程调试」还勾着",
    "Chrome 大版本更新后这个勾偶尔会被重置，这是最常见的原因",
    "以上都没问题就重启服务",
  ],
  "needs-login": ["在服务器那台 Chrome 里重新登录 ChatGPT，不用重启服务，会自动恢复"],
  challenge: ["在服务器那台 Chrome 里打开 ChatGPT，手动过一次 Cloudflare 验证"],
  error: ["服务器上的 Chrome 可能被关掉了，重新打开并确认远程调试仍开启"],
};

const json = (res, obj, code = 200, extra = {}) => {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    ...extra,
  });
  res.end(body);
};

// 附件上限。base64 会让体积涨约 1/3，所以 body 上限比附件上限留出余量。
const MAX_FILES = 6;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_BODY_PLAIN = 1e6;
const MAX_BODY_UPLOAD = 40 * 1024 * 1024;
const TOO_BIG = `附件太大（单条消息上限 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB）`;

/**
 * 读请求体。默认上限 1MB —— 普通接口不该被超大 body 拖垮。
 * 超过上限时 resolve null（而不是空对象）：调用方必须能区分
 * "用户没带附件"和"附件太大被丢了"，后者静默当成前者会把消息发空。
 */
const readBody = (req, maxBytes = MAX_BODY_PLAIN) =>
  new Promise((resolve) => {
    let data = "";
    let tooBig = false;
    let settled = false;
    // end 与 close 都会来，用 settled 保证只解析一次（大 body 解析两遍很亏）
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(tooBig ? null : parseBody(data));
    };
    req.on("data", (c) => {
      if (tooBig) return;
      data += c;
      if (data.length > maxBytes) {
        tooBig = true;
        data = "";
        req.destroy();
      }
    });
    req.on("end", finish);
    // destroy() 之后不一定还会触发 end，close 兜底
    req.on("close", finish);
  });

function parseBody(data) {
  try {
    return JSON.parse(data || "{}");
  } catch {
    return {};
  }
}

/** 从 cookie 解出当前用户；未登录返回 null。 */
function currentUser(req) {
  const payload = auth.verifyToken(auth.readToken(req));
  if (!payload) return null;
  const user = store.getUserByKey(payload.u);
  if (!user) return null;
  if ((user.tokenVersion || 1) !== payload.v) return null; // 改密后旧 token 立即失效
  return { user, payload };
}

// ---------- 通知 ----------

let noticesRev = 0;

async function notice(level, text) {
  noticesRev = await store.addNotice(level, text);
  broadcastAll("notices", { rev: noticesRev });
}

// ---------- SSE ----------
//
// 状态与通知是全体共享的（服务器浏览器只有一个），消息则只推给所属用户。
// 广播必须按 userKey 过滤，别图省事群发。

/** @type {Map<string, Set<import("node:http").ServerResponse>>} */
const streams = new Map();

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* 连接已断，close 事件里会清理 */
  }
}

function broadcast(userKey, event, data) {
  const set = streams.get(userKey);
  if (!set) return;
  for (const res of set) sseSend(res, event, data);
}

function broadcastAll(event, data) {
  for (const set of streams.values()) for (const res of set) sseSend(res, event, data);
}

/** 状态里 myAhead 是因人而异的，所以状态要逐个用户算 */
async function statusFor(userKey) {
  const s = chatgpt.getStatus();
  return {
    state: s.state,
    detail: s.detail,
    queueDepth: s.queueDepth,
    myPending: chatgpt.pendingFor(userKey),
    myAhead: chatgpt.queueAheadFor(userKey),
    busySessionId: s.busySessionId,
    noticesRev,
  };
}

async function sessionsPayload(userKey) {
  const list = await store.listSessions(userKey);
  return list.map((s) => ({
    id: s.id,
    title: s.title || "新会话",
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messageCount || 0,
    hasChat: !!s.chatUrl,
    pending: !!s.pending,
  }));
}

async function noticesPayload() {
  const { events } = await store.loadNotices();
  const s = chatgpt.getStatus();
  return {
    rev: noticesRev,
    current: { state: s.state, detail: s.detail, steps: STEPS[s.state] || [] },
    events: events.slice(-50).reverse(),
  };
}

const pushMessage = (userKey, sessionId, message) =>
  broadcast(userKey, "message", { sessionId, message });

// 推送是"顺手一推"，多处都没 await —— 自己把异常吃掉，
// 不能让一次读取失败顺着无人接管的 Promise 把进程带走
async function pushSessions(userKey) {
  try {
    broadcast(userKey, "sessions", { sessions: await sessionsPayload(userKey) });
  } catch (e) {
    console.warn("[推送] 会话列表没推出去:", e.message);
  }
}

// 状态变化很密集（每次入队/出队/切页），去抖后统一推
let statusTimer = null;
function scheduleStatusPush() {
  if (statusTimer) return;
  statusTimer = setTimeout(async () => {
    statusTimer = null;
    const keys = [...streams.keys()];
    for (const k of keys) sseSend2(k, "status", await statusFor(k));
  }, 150);
}
function sseSend2(userKey, event, data) {
  broadcast(userKey, event, data);
}

chatgpt.setQueueListener(scheduleStatusPush);
chatgpt.setStateListener(({ state, detail }) => {
  const level = state === "ready" ? "info" : "error";
  notice(level, state === "ready" ? "已连上 ChatGPT" : detail || state).catch(() => {});
  scheduleStatusPush();
});

// ---------- 发送 ----------

/**
 * 把一条消息派进队列，并在回复回来时落盘。
 * 不 await 生成过程 —— 一次可能要几分钟，HTTP 立刻返回。
 */
/**
 * 把回复里的图片下载到本地。
 * 必须借浏览器已登录的上下文取 —— ChatGPT 的图片地址要登录态，
 * 直接把那个 URL 给同事是打不开的。取回来之后由我们自己的服务转发。
 */
async function saveAttachments(user, sid, images, files) {
  const out = { images: [], files: [], failed: 0 };

  for (const img of images || []) {
    try {
      let buf, ext;
      if (img.src.startsWith("data:")) {
        const m = img.src.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.*)$/s);
        if (!m) {
          out.failed++;
          continue;
        }
        buf = Buffer.from(m[2], "base64");
        ext = m[1] === "jpeg" ? "jpg" : m[1];
      } else {
        const r = await chatgpt.fetchAsBase64(img.src);
        buf = Buffer.from(r.b64, "base64");
        ext = (r.type.split("/")[1] || "png").split(";")[0].trim();
      }
      if (!buf?.length) {
        out.failed++;
        continue;
      }
      const name = await store.saveAsset(user.key, sid, buf, ext);
      if (name) out.images.push({ file: name, alt: img.alt || "" });
      else out.failed++;
    } catch (e) {
      console.warn("[附件] 图片下载失败:", e.message);
      out.failed++;
    }
  }

  for (const f of files || []) {
    try {
      const buf = Buffer.from(f.b64, "base64");
      if (!buf.length) {
        out.failed++;
        continue;
      }
      const ext =
        (String(f.name || "").split(".").pop() || "").toLowerCase() ||
        (String(f.mime || "").split("/")[1] || "bin");
      const name = await store.saveAsset(user.key, sid, buf, ext);
      if (name) {
        out.files.push({
          file: name,
          name: f.name || "文件",
          mime: f.mime || "",
          size: buf.length,
        });
      } else out.failed++;
    } catch (e) {
      console.warn("[附件] 文件保存失败:", e.message);
      out.failed++;
    }
  }

  return out;
}

/** 从服务端记录里取回原始文件名 —— 不能信任客户端传来的名字（响应头注入） */
async function originalName(key, sid, stored) {
  const msgs = await store.readMessages(key, sid);
  for (let i = msgs.length - 1; i >= 0; i--) {
    for (const f of msgs[i].files || []) if (f.file === stored) return f.name;
  }
  return null;
}

/**
 * 解码并校验附件，**不落盘**。
 *
 * 落盘要 sid，而新建会话那条路必须先校验再建会话 —— 否则附件超限时会先建出
 * 一个空会话，正好踩中这个项目一直在躲的"一堆空会话"。
 * 所以拆成两步：这里只认字节，persistIncoming 才写磁盘。
 */
function decodeIncoming(files) {
  if (!Array.isArray(files) || !files.length) return { decoded: [], error: null };
  if (files.length > MAX_FILES) {
    return { decoded: [], error: `一条消息最多带 ${MAX_FILES} 个附件` };
  }

  const decoded = [];
  let total = 0;
  for (const f of files) {
    const buf = Buffer.from(String(f?.b64 || ""), "base64");
    if (!buf.length) continue;
    total += buf.length;
    if (total > MAX_UPLOAD_BYTES) {
      return { decoded: [], error: `附件总大小超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` };
    }
    // 原始文件名是用户可控字符串：要用于显示、下载头，还要传给 ChatGPT 当文件名，
    // 在这里统一截断一次。存盘名另由 store.saveAsset 生成，绝不拿它拼路径。
    decoded.push({
      buf,
      name: String(f?.name || "文件").slice(0, 120),
      mime: String(f?.mime || ""),
    });
  }
  return { decoded, error: null };
}

// 上传的图片直接显示，其余给下载块。后缀走的是 store 生成的白名单名。
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);
const isImageAttachment = (mime, stored) =>
  String(mime).startsWith("image/") ||
  IMAGE_EXT.has(String(stored).split(".").pop() || "");

/** 把解码好的附件落盘。每项带上的 buffer 只用于这一趟转发，不写进消息记录。 */
async function persistIncoming(user, sid, decoded) {
  const saved = [];
  for (const d of decoded) {
    const ext = (d.name.split(".").pop() || "").toLowerCase();
    const file = await store.saveAsset(user.key, sid, d.buf, ext);
    if (!file) continue;
    saved.push({ file, name: d.name, mime: d.mime, size: d.buf.length, buffer: d.buf });
  }
  return saved;
}

async function dispatch(user, session, text, decoded = []) {
  const saved = await persistIncoming(user, session.id, decoded);

  // 首条消息生成标题（用户手动改过名就不动）。
  // 只丢文件不写字时用文件名兜底，否则会话栏里会是一排没头没尾的"新会话"。
  if (!session.titleLocked && !session.title) {
    const seed = text || saved[0]?.name || "";
    if (seed) {
      await store.updateSession(user.key, session.id, { title: store.titleFrom(seed) });
    }
  }

  // 图片直接显示，其余给下载块 —— 两者都记成"文件"会重复：一张截图既能看
  // 又挂一个"下载"标签，纯属噪音。
  const pics = saved.filter((s) => isImageAttachment(s.mime, s.file));
  const docs = saved.filter((s) => !isImageAttachment(s.mime, s.file));

  const userMsg = await store.appendMessage(user.key, session.id, {
    role: "user",
    text,
    ts: Date.now(),
    ...(pics.length ? { images: pics.map((s) => ({ file: s.file, alt: s.name })) } : {}),
    // buffer 绝不能进 JSONL —— 那会变成几十 MB 的 base64 躺在聊天记录里
    ...(docs.length ? { files: docs.map(({ buffer, ...rest }) => rest) } : {}),
  });
  pushMessage(user.key, session.id, userMsg);
  pushSessions(user.key);

  const { queued, done } = chatgpt.send({
    chatUrl: session.chatUrl,
    text,
    userKey: user.key,
    sessionId: session.id,
    // 生成过程中把已落下的正文实时推给这个人，只推给他 ——
    // 和消息一样按 userKey 过滤，别人看不到他在写什么。
    // 这里不落盘：落盘的永远是 done 里那份最终结果，中途片段刷新即弃。
    onProgress: ({ text: partial }) =>
      broadcast(user.key, "streaming", { sessionId: session.id, text: partial }),
    files: saved,
  });

  done.then(
    async ({ reply, images, files, chatUrl }) => {
      // 会话绑定回传的地址 —— 这就是「回到历史会话继续聊」的落点
      if (chatUrl && chatUrl !== session.chatUrl) {
        await store.updateSession(user.key, session.id, { chatUrl });
      }
      const att = await saveAttachments(user, session.id, images, files);
      const msg = await store.appendMessage(user.key, session.id, {
        role: "assistant",
        text: reply,
        ts: Date.now(),
        ...(att.images.length ? { images: att.images } : {}),
        ...(att.files.length ? { files: att.files } : {}),
        // 有东西没取到就说出来，别让用户以为回复就是空的
        ...(att.failed ? { failedAttachments: att.failed } : {}),
      });
      pushMessage(user.key, session.id, msg);
      pushSessions(user.key);
    },
    async (e) => {
      const msg = await store.appendMessage(user.key, session.id, {
        role: "assistant",
        text: ERR_TEXT[e.code] || e.message || "转发失败",
        ts: Date.now(),
        error: true,
      });
      pushMessage(user.key, session.id, msg);
      pushSessions(user.key);
    },
  )
    // 这条链没人 await：里面任何一步抛错都会变成 unhandled rejection，
    // 而 unhandled rejection 会让整个进程退出 —— 一次落盘抖动就是全员断线。
    // 回复取回来了却没能落盘，属于只有开发者能处理的事，记进开发者日志。
    .catch(async (e) => {
      console.warn("[发送] 回复没能落盘:", e.message);
      await store.logForDeveloper("有一条回复没能写进聊天记录", {
        用户: `${user.name} (${user.key})`,
        会话标题: session.title || "(无标题)",
        "会话 id": session.id,
        失败原因: e.message,
        处理建议: "这条回复只存在于 ChatGPT 里，中转站这边看不到，让同事重发一次",
      });
    });

  return queued;
}

/** 取会话并校验归属。返回 null 表示不存在或不属于该用户。 */
async function ownedSession(user, sid) {
  return store.getSession(user.key, sid);
}

// ---------- 路由 ----------

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const method = req.method;

  // 静态资源
  if (method === "GET" && STATIC[p]) {
    const { file, type } = STATIC[p];
    try {
      const body = await readFile(path.join(PUBLIC_DIR, file));
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": body.length,
        // 必须显式禁止启发式缓存：这几个文件没有带任何缓存头，浏览器会自己
        // 按 Last-Modified 猜一个缓存期。改了 app.js 之后同事那边可能还是旧的，
        // 表现成"改了没生效"，很难查。内网小文件，每次重新取一遍不心疼。
        "Cache-Control": "no-cache",
      });
      return res.end(body);
    } catch {
      return res.writeHead(404).end("not found");
    }
  }

  // 未鉴权的健康状态：登录页要显示服务器好不好，但不能泄漏队列与用户名
  if (method === "GET" && p === "/api/health") {
    const s = chatgpt.getStatus();
    return json(res, { state: s.state, detail: s.detail });
  }

  // ---- 登录 / 注册 ----

  if (method === "POST" && p === "/api/register") {
    const { name, password } = await readBody(req);
    const bad = store.validateName(name);
    if (bad) return json(res, { error: bad }, 400);
    if (!password) return json(res, { error: "密码不能为空" }, 400);
    if (store.findUserByName(name)) {
      return json(res, { error: "这个账号已经被占用了" }, 409);
    }
    const pwd = await auth.hashPassword(password);
    const user = await store.createUser(name, pwd);
    return json(
      res,
      { ok: true, name: user.name },
      200,
      { "Set-Cookie": auth.issueCookie(user) },
    );
  }

  if (method === "POST" && p === "/api/login") {
    const { name, password } = await readBody(req);
    const nk = store.nameKeyOf(name);
    const locked = auth.lockedFor(nk);
    if (locked) {
      return json(res, { error: `尝试太频繁，请 ${Math.ceil(locked / 1000)} 秒后再试` }, 429);
    }
    const user = store.findUserByName(name);
    // 用户不存在也跑一次哈希，避免响应时间泄漏账号是否存在
    const ok = user
      ? await auth.verifyPassword(password, user.pwd)
      : await auth.verifyPassword(password, { salt: "00".repeat(16), hash: "00".repeat(64) });

    if (!ok || !user) {
      auth.noteFailure(nk);
      return json(res, { error: "账号或密码不对" }, 401);
    }
    auth.noteSuccess(nk);
    return json(
      res,
      { ok: true, name: user.name },
      200,
      { "Set-Cookie": auth.issueCookie(user) },
    );
  }

  if (method === "POST" && p === "/api/logout") {
    return json(res, { ok: true }, 200, { "Set-Cookie": auth.clearCookie() });
  }

  // ---- 以下全部需要登录 ----

  const who = currentUser(req);
  if (!who) return json(res, { error: "未登录" }, 401);
  const { user, payload } = who;

  // 滑动续期：只在快到期时重发，避免每请求都 Set-Cookie
  const renewed = auth.issueCookie(user, payload);
  const cookieHeader = renewed ? { "Set-Cookie": renewed } : {};

  if (method === "GET" && p === "/api/me") {
    // 联系方式要登录后才下发：它是给同事看的，不是给整个内网看的
    return json(res, { name: user.name, adminContact: ADMIN_CONTACT }, 200, cookieHeader);
  }

  // 实时推送。EventSource 会带 cookie，所以鉴权与普通请求一致。
  if (method === "GET" && p === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // 将来前面加反代也不会把流缓冲住
    });
    req.socket.setTimeout(0); // 默认 socket 超时会掐掉长连接
    res.write(": connected\n\n");

    let set = streams.get(user.key);
    if (!set) streams.set(user.key, (set = new Set()));
    set.add(res);

    // 连上先给一份完整快照，前端不必再单独拉一次
    sseSend(res, "snapshot", {
      me: { name: user.name },
      config: { adminContact: ADMIN_CONTACT },
      status: await statusFor(user.key),
      sessions: await sessionsPayload(user.key),
      notices: await noticesPayload(),
    });

    const hb = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* close 会清理 */
      }
    }, 25000);

    req.on("close", () => {
      clearInterval(hb);
      set.delete(res);
      if (!set.size) streams.delete(user.key);
    });
    return; // 故意不 end()：这是长连接
  }

  if (method === "GET" && p === "/api/status") {
    const s = chatgpt.getStatus();
    return json(
      res,
      {
        state: s.state,
        detail: s.detail,
        queueDepth: s.queueDepth,
        myPending: chatgpt.pendingFor(user.key),
        myAhead: chatgpt.queueAheadFor(user.key),
        busySessionId: s.busySessionId,
        noticesRev,
      },
      200,
      cookieHeader,
    );
  }

  if (method === "GET" && p === "/api/notices") {
    return json(res, await noticesPayload());
  }

  // 同事点"反馈"：把此刻的维护消息原样存档，方便管理员照着排查
  if (method === "POST" && p === "/api/feedback") {
    const snap = await noticesPayload();
    const ok = await store.saveFeedback(user.name, {
      current: snap.current,
      // 只留最近几条，全量 50 条会让日志难以阅读
      events: (snap.events || []).slice(0, 8),
    });
    return json(res, { ok }, ok ? 200 : 500);
  }

  // ---- 会话 ----

  if (method === "GET" && p === "/api/sessions") {
    const list = await store.listSessions(user.key);
    return json(res, {
      sessions: list.map((s) => ({
        id: s.id,
        title: s.title || "新会话",
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount || 0,
        hasChat: !!s.chatUrl,
        pending: !!s.pending,
      })),
    });
  }

  // 原子操作：建会话 + 立即发出首条消息，避免留下一堆空会话
  if (method === "POST" && p === "/api/sessions") {
    const body = await readBody(req, MAX_BODY_UPLOAD);
    if (!body) return json(res, { error: TOO_BIG }, 413);
    const clean = String(body.text || "").trim();
    const { decoded, error } = decodeIncoming(body.files);
    if (error) return json(res, { error }, 400);
    // 带附件时可以只发文件不写字，所以判空要连附件一起看
    if (!clean && !decoded.length) return json(res, { error: "内容为空" }, 400);
    if (chatgpt.pendingFor(user.key) >= MAX_PENDING_PER_USER) {
      return json(res, { error: `你还有 ${MAX_PENDING_PER_USER} 条在处理中，等回复回来再发` }, 429);
    }
    const session = await store.createSession(user.key);
    await pushSessions(user.key);
    const queued = await dispatch(user, session, clean, decoded);
    return json(res, { ok: true, sessionId: session.id, queued }, 200, cookieHeader);
  }

  const m = p.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})(\/.*)?$/);
  if (m) {
    const sid = m[1];
    const action = m[2] || "";
    const session = await ownedSession(user, sid);
    if (!session) return json(res, { error: "会话不存在" }, 404);

    // 附件：同在会话归属校验保护下，存盘名必须过白名单。
    // /images/ 内联显示，/files/ 触发下载。
    if (
      method === "GET" &&
      (action.startsWith("/images/") || action.startsWith("/files/"))
    ) {
      const isFile = action.startsWith("/files/");
      const stored = decodeURIComponent(action.slice((isFile ? "/files/" : "/images/").length));
      const file = store.assetFile(user.key, sid, stored);
      if (!file) return json(res, { error: "找不到附件" }, 404);
      try {
        const buf = await readFile(file);
        const headers = {
          "Content-Type": MIME[path.extname(file).slice(1)] || "application/octet-stream",
          "Content-Length": buf.length,
          "Cache-Control": "private, max-age=31536000, immutable",
        };
        if (isFile) {
          // 原始文件名从服务端记录里取，不用客户端传来的（响应头注入）
          const orig = (await originalName(user.key, sid, stored)) || "download";
          headers["Content-Disposition"] =
            `attachment; filename*=UTF-8''${encodeURIComponent(orig)}`;
        }
        res.writeHead(200, headers);
        return res.end(buf);
      } catch {
        return json(res, { error: "找不到附件" }, 404);
      }
    }

    if (method === "PATCH" && !action) {
      const { title } = await readBody(req);
      const t = String(title || "").trim();
      if (!t) return json(res, { error: "标题不能为空" }, 400);
      await store.renameSession(user.key, sid, t);
      await pushSessions(user.key);
      return json(res, { ok: true });
    }

    if (method === "DELETE" && !action) {
      if (session.pending) {
        return json(res, { error: "正在生成中，等它结束再删" }, 409);
      }
      // 先把 ChatGPT 侧删掉再删本地：本地删了就没地址了，反过来做不到。
      // 远程失败不阻止本地删除，但要把原因带回前端。
      const remote = session.chatUrl
        ? await chatgpt.deleteConversation(session.chatUrl)
        : { ok: true, skipped: "这个会话还没在 ChatGPT 里建立对话" };

      // 本地删了、远程没删掉 —— 会在 ChatGPT 项目里留下一个孤儿对话，
      // 需要人工善后，所以落到开发者日志里（站内通知面板是给全体同事看故障的，
      // 这类只有开发者能处理的事塞进去只会是噪音）
      if (remote.ok === false) {
        await store.logForDeveloper(
          `用户「${user.name}」删除会话成功，但 ChatGPT 侧删除失败`,
          {
            用户: `${user.name} (${user.key})`,
            会话标题: session.title || "(无标题)",
            "会话 id": sid,
            远程对话: session.chatUrl,
            失败原因: remote.reason,
            处理建议: "到 ChatGPT 项目里手动删掉这个对话；本地记录已删除，不影响使用",
          },
        );
      }

      await store.deleteSession(user.key, sid);
      await pushSessions(user.key);
      return json(res, { ok: true, remote });
    }

    if (method === "GET" && action === "/messages") {
      const since = Math.max(0, Number(url.searchParams.get("since") || 0));
      const all = await store.readMessages(user.key, sid);
      return json(res, {
        sessionId: sid,
        total: all.length,
        since,
        messages: all.slice(since),
      });
    }

    if (method === "POST" && action === "/send") {
      const body = await readBody(req, MAX_BODY_UPLOAD);
      if (!body) return json(res, { error: TOO_BIG }, 413);
      const clean = String(body.text || "").trim();
      const { decoded, error } = decodeIncoming(body.files);
      if (error) return json(res, { error }, 400);
      if (!clean && !decoded.length) return json(res, { error: "内容为空" }, 400);

      // 一个会话同时只允许一条在飞。这不只是体验问题：
      // 并发发送会让 JSONL 顺序错成 user1,user2,assistant1,assistant2。
      if (session.pending) {
        return json(res, { error: "这个会话还有一条在等回复，等它回来再发" }, 409);
      }
      if (chatgpt.pendingFor(user.key) >= MAX_PENDING_PER_USER) {
        return json(res, { error: `你还有 ${MAX_PENDING_PER_USER} 条在处理中，等回复回来再发` }, 429);
      }

      const queued = await dispatch(user, session, clean, decoded);
      return json(res, { ok: true, queued }, 200, cookieHeader);
    }

    if (method === "POST" && action === "/clear") {
      if (session.pending) return json(res, { error: "正在生成中，稍后再清" }, 409);
      await store.clearMessages(user.key, sid);
      broadcast(user.key, "cleared", { sessionId: sid });
      await pushSessions(user.key);
      return json(res, { ok: true });
    }
  }

  json(res, { error: "not found" }, 404);
}

// ---------- 启动 ----------

await store.init();
await store.initUsers();
await auth.initAuth();

/** 重启自愈：队列蒸发后，末条是用户消息的会话会永远没人回，补一条提示 */
async function selfHeal() {
  for (const u of store.allUsers()) {
    for (const s of await store.listSessions(u.key)) {
      const msgs = await store.readMessages(u.key, s.id);
      const last = msgs[msgs.length - 1];
      if (last?.role === "user") {
        await store.appendMessage(u.key, s.id, {
          role: "assistant",
          text: "服务重启，这条消息未能送达，请重发",
          ts: Date.now(),
          error: true,
        });
      }
    }
  }
}
await selfHeal();

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) json(res, { error: e.message }, 500);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ChatGPT 网页中转站`);
  console.log(`  本机     http://127.0.0.1:${PORT}`);
  console.log(`  内网     http://<这台机器的内网IP>:${PORT}`);
  // 把生效的项目地址打出来：配错了是这一步最常见的坑，写在这儿一眼就能对上
  console.log(`  项目     ${chatgpt.projectUrl() || "(未配置项目地址)"}\n`);
});

chatgpt.start().catch((e) => {
  console.error("[启动] 连接 Chrome 失败:", e.message);
});

setTimeout(() => {
  const s = chatgpt.getStatus();
  if (s.state !== "ready") {
    console.warn(`\n  ⚠ ${s.detail}`);
    if (s.state === "no-browser") {
      console.warn("  在 Chrome 地址栏打开 chrome://inspect/#remote-debugging");
      console.warn("  勾选允许远程调试，然后重启本服务。");
    }
    console.warn("");
  }
}, 12000);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log("\n正在关闭…");
    await chatgpt.stop();
    server.close();
    process.exit(0);
  });
}
