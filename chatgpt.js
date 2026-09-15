// 转发核心：连上你自己那个已登录的 Chrome，把消息送进 ChatGPT 并把回复取回来。
//
// 本模块是**无状态执行器**：只认「目标对话地址 + 文本」，回传「回复 + 落定地址」。
// 会话归属、标题、历史统统归 store 管，这里不 import 任何存储。
//
// 为什么是「连接」而不是「启动」：Chrome 127 起用 App-Bound Encryption 保护 cookie，
// 拷 profile 到别的目录后登录态解不开（已实测）；Chrome 136 起又禁止对默认 profile
// 开远程调试端口。剩下的官方通道是 chrome://inspect/#remote-debugging ——
// 用户手动授权一次，我们连上去，不拷贝、不解密。
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

/**
 * 要操作的那个 ChatGPT 项目，地址来自 config.json / 环境变量的
 * CHATGPT_PROJECT_URL（见 config.js 顶上关于为什么不用 .bat 的说明）。
 *
 * 直接抄浏览器地址栏里 /project 之前的那一段即可（带上 /project 也能认，
 * 尾斜杠、查询串都认）。所有对话都发生在这个项目的命名空间里，别的地方一律不碰。
 *
 * 做成函数而不是模块级常量：配置要等 config() 被真正调用时才读。
 * 挂在模块加载期的话，读到的是还没合并 config.json 的环境变量 ——
 * ESM 的 import 先于模块体执行，server.js 里再怎么提前读盘也追不上。
 */
const projectBase = () =>
  String(config().projectUrl || "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\/project\/?$/, "")
    .replace(/\/+$/, "");

export const projectUrl = () => `${projectBase()}/project`;

const CHROME_USER_DATA =
  process.env.CHROME_USER_DATA ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "Google",
    "Chrome",
    "User Data",
  );

// 每项首个命中的生效。第一个是原方案实战验证过的，后面是降级备选。
const SEL = {
  input: ["#prompt-textarea", "div.ProseMirror[contenteditable='true']"],
  send: ['[data-testid="send-button"]', 'button[aria-label="Send prompt"]'],
  stop: ['[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]'],
  // 生成图片时会有这些加载标志。它们在阶段切换的空档可能和停止按钮错开，
  // 所以要一起判断，否则会在"文字已稳定、图还没出来"时误判为完成。
  loading: [
    '[data-testid="loading-halftone-dots-animation"]',
    '[class*="loading-shimmer"]',
  ],
  newChat: [
    '[data-testid="create-new-chat-button"]',
    'a[href$="/project"]',
    'button[aria-label="New chat"]',
  ],
  // 上传入口是 composer 表单里那个常驻的隐藏 input，不用去点 "+" 菜单。
  // 页面上还有几个 accept="image/*" 的 input，它们都不在表单里，用 form 限定正好。
  file: 'form input[type="file"]',
  login: [
    '[data-testid="login-button"]',
    'button[data-testid="login-button"]',
    'a[href^="/auth/login"]',
  ],
  challenge: ["#challenge-form", "iframe[src*='challenges.cloudflare.com']"],
};

export class RelayError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // NO_BROWSER | NEEDS_LOGIN | CHALLENGE | TIMEOUT | SELECTOR | SESSION_GONE | NAV
  }
}

const status = {
  state: "starting", // starting | ready | no-browser | needs-login | challenge | error
  detail: "",
  busyUser: null,
  busySessionId: null,
  lastError: null,
};

let onStateChange = null;
/** 注册状态变化回调（server 用它写通知日志、推 SSE） */
export const setStateListener = (fn) => {
  onStateChange = fn;
};

let onQueueChange = null;
/** 队列变化回调（入队/出队/开始处理时触发，供 SSE 推状态） */
export const setQueueListener = (fn) => {
  onQueueChange = fn;
};

function setState(state, detail = "") {
  const changed = status.state !== state || status.detail !== detail;
  status.state = state;
  status.detail = detail;
  onQueueChange?.(); // 状态变了，队列位置也会变
  if (changed) onStateChange?.({ state, detail });
}

let browser = null;
let context = null;
let page = null;

/** 队列里等待的任务，用于「每人待处理上限」与前端排队提示。不含消息正文。 */
const queue = [];

export const getStatus = () => ({ ...status, queueDepth: queue.length });
export const pendingFor = (userKey) =>
  queue.filter((q) => q.userKey === userKey).length +
  (status.busyUser === userKey ? 1 : 0);

/**
 * 该用户最早那条待处理消息前面还有几条。
 * 返回 null 表示他没有在等的东西。前端据此显示「排队中，前面还有 N 条」。
 */
export function queueAheadFor(userKey) {
  const idx = queue.findIndex((q) => q.userKey === userKey);
  if (idx >= 0) {
    // 正在跑的那条若属于别人，也算在他前面
    return idx + (status.busyUser && status.busyUser !== userKey ? 1 : 0);
  }
  return status.busyUser === userKey ? 0 : null;
}

// ---------- 连接 ----------

// Chrome 把调试端口和 ws 路径写在 DevToolsActivePort 里（内建调试不暴露 /json/version）
function resolveEndpoint() {
  if (process.env.CHROME_CDP) return process.env.CHROME_CDP;
  const file = path.join(CHROME_USER_DATA, "DevToolsActivePort");
  let port, wsPath;
  try {
    [port, wsPath] = readFileSync(file, "utf-8").split("\n");
  } catch {
    throw new RelayError(
      "NO_BROWSER",
      `读不到 ${file} —— 你的 Chrome 没在跑，或者还没打开远程调试开关`,
    );
  }
  if (!port?.trim() || !wsPath?.trim()) {
    throw new RelayError("NO_BROWSER", "DevToolsActivePort 内容不完整，请在 Chrome 里重新开启调试开关");
  }
  return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
}

const normalize = (u) => String(u || "").split("?")[0].split("#")[0];

/**
 * Playwright 的报错常带 ANSI 转义码和几十行 call log。
 * 通知面板是给同事看的，只留第一行、剥掉控制字符、限长。
 */
function cleanErr(e) {
  const raw = String(e?.message || e || "未知错误");
  const first = raw.split("\n")[0];
  // 用转义写控制字符，绝不把不可见字符嵌进源码
  return first
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, 120);
}

// 整个项目命名空间归本工具所有：含项目页与项目下所有 /c/<uuid>。
// 不匹配你个人的 chatgpt.com/c/<uuid>（不带 /g/）、首页、别的项目。
function isOurs(url) {
  return normalize(url).startsWith(projectBase() + "/");
}

// 首次连到 Chrome 内建调试端点实测可能要几十秒（Playwright 默认只等 30 秒，
// 启动时必超时），所以显式放宽并重试一次。
async function connect() {
  const endpoint = resolveEndpoint();
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 90000 });
      break;
    } catch (e) {
      lastErr = e;
      if (i === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!browser?.isConnected()) {
    // 对同事只说人话；技术细节留给服务端终端，别漏进维护消息面板
    console.warn("[连接] 详细错误:", cleanErr(lastErr));
    throw new RelayError("NO_BROWSER", "连不上你的 Chrome，请按下面的步骤检查");
  }

  context = browser.contexts()[0];
  if (!context) throw new RelayError("NO_BROWSER", "连上了浏览器但拿不到上下文");
  browser.on("disconnected", () => {
    browser = null;
    context = null;
    page = null;
  });
}

/**
 * 拿到我们自己的那个标签页。
 * 有内存引用就直接用；重连后在候选里**优先挑后台的**——避免抢走
 * 用户正在阅读的页面（他会点开项目里的对话来看）。
 */
async function acquirePage() {
  if (page && !page.isClosed()) return page;
  if (!browser?.isConnected() || !context) await connect();

  const candidates = context.pages().filter((p) => isOurs(p.url()));
  for (const p of candidates) {
    const hidden = await p
      .evaluate(() => document.visibilityState === "hidden")
      .catch(() => false);
    if (hidden) {
      page = p;
      return page;
    }
  }
  // 候选全在前台（或没有候选）：宁可多开一个，也不抢别人正在看的
  page = candidates.length === 1 ? candidates[0] : await context.newPage();
  return page;
}

/**
 * 拿到一个**确实位于 chatgpt.com 上**的页面。
 *
 * 这一点必须显式保证：下面所有 /backend-api/... 的调用都是页面内的相对路径 fetch，
 * 如果页面还在 about:blank 或别的站点上，请求会打到错误的源并返回 404 ——
 * 看起来像"对话不存在"，其实是假失败。
 */
async function ensureOnChatGPT() {
  const p = await acquirePage();
  if (!/^https:\/\/chatgpt\.com\//.test(p.url())) {
    await p.goto(projectUrl(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.waitForTimeout(1500);
  }
  return p;
}

// ---------- 页面探测（全部走 evaluate，不用 $$ —— 那些 ElementHandle 从不 dispose） ----------

const hasAny = (selectors) =>
  page.evaluate((sels) => sels.some((s) => document.querySelector(s)), selectors);

async function waitForAny(selectors, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) && (await loc.isVisible())) return { loc, sel };
    }
    await page.waitForTimeout(200);
  }
  throw new RelayError(
    "SELECTOR",
    `页面上找不到 ${selectors[0]}（ChatGPT 界面可能改版了，或在登录页）`,
  );
}

async function clickAny(selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) && (await loc.isVisible())) {
      await loc.click();
      return sel;
    }
  }
  return null;
}

/**
 * 在页面里读一次"最后一条助手回复"。
 *
 * 锚点必须是**回合包装器** `[data-turn="assistant"]`，不能用
 * `[data-message-author-role="assistant"]` —— 实测生成图片的回合里
 * 那个 role 节点根本不存在，用它会以为"回复一直没出现"从而空等到超时。
 * 图片也在回合里（div#image-…），不在 role 节点内。
 *
 * 顺带在同一趟里把"还在不在写"也判了。这两件事每次轮询都要问，拆成两次
 * evaluate 就多一个 CDP 往返 —— 实测每轮会多花几百毫秒，流式就会一顿一顿的。
 *
 * 两个信号的可信度不一样，必须分开回传（见 waitReply 里的说明）：
 *   loading —— 加载动画，页面真的在动，硬信号
 *   stop    —— 停止按钮，实测会卡住不换回发送态，只能算软信号
 */
function snapInPage(sels) {
  const turns = document.querySelectorAll('[data-turn="assistant"]');
  const n = turns.length;
  const hit = (list) => list.some((s) => document.querySelector(s));
  const stop = hit(sels.stop);
  const loading = hit(sels.loading);
  if (!n) return { count: 0, last: "", images: [], stop, loading };

  const el = turns[n - 1];

  // 文字回复有 role 节点，用它取干净的正文
  const roleNode = el.querySelector('[data-message-author-role="assistant"]');
  let text = "";
  if (roleNode) {
    text = roleNode.innerText.trim();
  } else {
    // 图片回合没有 role 节点。克隆一份剔掉交互元素，免得把
    // "编辑""复制回复"这类按钮文字当成正文
    const clone = el.cloneNode(true);
    clone.querySelectorAll("button, svg, nav, [role='menu'], .sr-only").forEach((x) => x.remove());
    text = (clone.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  // 同一张生成图在 DOM 里会出现多次（叠了三层 <img> 做动画），必须按 src 去重，
  // 否则同一张图会被下载并存好几份
  const seen = new Set();
  const images = [];
  for (const img of el.querySelectorAll("img")) {
    const src = img.currentSrc || img.src || "";
    if (!src || src.startsWith("data:image/svg")) continue;
    if ((img.naturalWidth || 0) < 64) continue; // 排掉头像与占位图
    if (seen.has(src)) continue;
    seen.add(src);
    images.push({ src, alt: img.alt || "" });
  }

  return { count: n, last: text, images, stop, loading };
}

const PROBE_SEL = { stop: SEL.stop, loading: SEL.loading };

const assistantSnapshot = () => page.evaluate(snapInPage, PROBE_SEL);

/**
 * 采集回复里生成的文件（Code Interpreter 产物）。
 *
 * 不走 DOM —— 实测 DOM 里文件是 <button> 卡片，没有可用的 href，抓不到地址。
 * 改读会话 JSON（已实测跑通）：
 *   会话 id → /api/auth/session 取 accessToken → 带 Bearer 读会话
 *   → 助手消息文本里带 `sandbox:/mnt/data/xxx.csv` → /interpreter/download 换签名地址
 *   → 页面内 fetch 拿字节
 * 注意这些接口**只靠 cookie 会返回 404**（伪装成会话不存在），必须带 Bearer。
 */
async function collectFiles() {
  const cid = (page.url().match(/\/c\/([0-9a-f-]{36})/) || [])[1];
  if (!cid) return [];

  try {
    return await (await ensureOnChatGPT()).evaluate(async (convId) => {
      const out = [];
      const tok = (await fetch("/api/auth/session").then((r) => r.json())).accessToken;
      if (!tok) return out;

      const conv = await fetch(`/backend-api/conversation/${convId}`, {
        headers: { Authorization: "Bearer " + tok },
      }).then((r) => r.json());

      // 只看最后一条助手消息：取更早的会把历史文件重复采集一遍
      const assistants = Object.values(conv.mapping || {})
        .map((n) => n.message)
        .filter((m) => m?.author?.role === "assistant")
        .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
      const last = assistants[assistants.length - 1];
      if (!last) return out;

      const paths = new Set();
      for (const part of last.content?.parts || []) {
        if (typeof part !== "string") continue;
        for (const m of part.matchAll(/sandbox:(\/mnt\/data\/[^\s)\]"'<>]+)/g)) {
          paths.add(m[1]);
        }
      }

      for (const p of paths) {
        try {
          const u =
            `/backend-api/conversation/${convId}/interpreter/download` +
            `?message_id=${last.id}&sandbox_path=${encodeURIComponent(p)}`;
          const d = await fetch(u, { headers: { Authorization: "Bearer " + tok } }).then((r) =>
            r.json(),
          );
          if (!d.download_url) continue;

          const r = await fetch(d.download_url, { credentials: "include" });
          if (!r.ok) continue;
          const buf = new Uint8Array(await r.arrayBuffer());

          let bin = "";
          const CH = 0x8000;
          for (let i = 0; i < buf.length; i += CH) {
            bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
          }
          out.push({
            name: p.split("/").pop(),
            mime: d.mime_type || r.headers.get("content-type") || "",
            size: d.file_size_bytes || buf.length,
            b64: btoa(bin),
          });
        } catch {
          /* 单个文件失败不影响其他 */
        }
      }
      return out;
    }, cid);
  } catch {
    return []; // 采集失败不该让整条回复失败
  }
}

/**
 * 删除 ChatGPT 侧对应的对话。
 *
 * 实测：对 /backend-api/conversation/<id> 发 PATCH {"is_visible":false} 返回
 * {"success":true}，之后该对话再取就是 404 —— 界面上的"删除"做的是同一件事。
 *
 * 只对项目命名空间下的地址生效，绝不会碰到你自己在 chatgpt.com/c/… 的私人对话。
 */
export async function deleteConversation(chatUrl) {
  const m = String(chatUrl || "").match(/\/c\/([0-9a-f-]{36})/);
  if (!m) return { ok: true, skipped: "这个会话还没在 ChatGPT 里建立对话" };
  if (!isOurs(chatUrl)) return { ok: false, reason: "这个地址不属于本项目，已跳过" };

  try {
    const p = await ensureOnChatGPT();
    const r = await p.evaluate(async (cid) => {
      const tok = (await fetch("/api/auth/session").then((x) => x.json())).accessToken;
      if (!tok) return { status: 0, noToken: true };
      const resp = await fetch(`/backend-api/conversation/${cid}`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer " + tok,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ is_visible: false }),
      });
      return { status: resp.status };
    }, m[1]);

    if (r.status === 200) return { ok: true };
    // 已经是这个状态：对面上早就没了，当作成功，别拿它去打扰用户
    if (r.status === 404) return { ok: true, skipped: "ChatGPT 里已经没有这个对话了" };
    if (r.noToken) return { ok: false, reason: "拿不到 ChatGPT 登录态" };
    return { ok: false, reason: `ChatGPT 返回 ${r.status}` };
  } catch (e) {
    // 删不掉不该阻止本地删除，把原因带回去给前端提示
    return { ok: false, reason: cleanErr(e) };
  }
}

// 用页面自己的 fetch 下载图片：ChatGPT 的图片地址要登录态，直链对同事无效，
// 所以必须借浏览器已登录的上下文取回来，再由我们自己的服务转发出去。
export async function fetchAsBase64(url) {
  const p = await ensureOnChatGPT();
  return p.evaluate(async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000; // 分块，避免超长参数把调用栈撑爆
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    return { b64: btoa(bin), type: r.headers.get("content-type") || "" };
  }, url);
}

// ---------- 登录态 ----------

async function checkReady() {
  if (await hasAny(SEL.challenge)) {
    setState("challenge", "被 Cloudflare 拦截，需要在你的 Chrome 里人工过一次验证");
    return false;
  }
  if (/\/auth\/login|\/auth\/0/.test(page.url()) || (await hasAny(SEL.login))) {
    setState("needs-login", "未登录或登录已过期");
    return false;
  }
  setState("ready");
  return true;
}

// ---------- 生命周期 ----------

export async function start() {
  // 没配项目地址就没法干活。但服务要照常起来 —— 登录页和通知面板得靠它
  // 把原因和排查步骤说给部署的人听，直接崩掉反而什么都看不到。
  if (!projectBase()) {
    setState("no-project", "没配置 ChatGPT 项目地址，所有对话都无处可去");
    return;
  }
  try {
    await acquirePage();
    await page.goto(projectUrl(), { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2500);
    if (await checkReady()) console.log("[启动] 已连上你的 Chrome，ChatGPT 已登录，就绪");
    else {
      console.warn(`[启动] ${status.detail}`);
      pollUntilReady();
    }
  } catch (e) {
    const msg = cleanErr(e);
    setState("no-browser", msg);
    console.warn(`\n[启动] ${msg}`);
    if (e.code === "NO_BROWSER") {
      console.warn("  在 Chrome 地址栏打开 chrome://inspect/#remote-debugging");
      console.warn("  勾选允许远程调试，然后重启本服务。详见 README。\n");
    }
    pollUntilReady();
  }
}

function pollUntilReady() {
  const timer = setInterval(async () => {
    try {
      await acquirePage();
      if (await checkReady()) {
        console.log("[连接] 已恢复，就绪");
        clearInterval(timer);
      }
    } catch {
      /* 还没好，下轮再试 */
    }
  }, 5000);
}

// 只断开，绝不 browser.close() —— 那会把用户的浏览器一起关掉
export async function stop() {
  browser?.close().catch(() => {});
}

// ---------- 串行队列 ----------

let chain = Promise.resolve();

function enqueue(task) {
  const result = chain.then(task);
  chain = result.then(
    () => {},
    () => {},
  );
  return result;
}

// ---------- 发送 ----------

/**
 * 新会话的首条消息必须落在一个全新的对话里。
 * 若项目页回退到了某个历史对话而我们把消息发出去，就会**串进别人的会话**，
 * 双方都察觉不到 —— 所以这里宁可抛错也不发。
 */
async function ensureFreshChat() {
  if (!normalize(page.url()).includes("/c/")) return; // 已经是干净的项目页

  const clicked = await clickAny(SEL.newChat);
  if (clicked) {
    await page.waitForTimeout(1500);
    if (!normalize(page.url()).includes("/c/")) return;
  }
  throw new RelayError(
    "SELECTOR",
    "无法在项目下开启新对话（页面停在了一个历史对话上，界面可能改版）",
  );
}

/**
 * 把附件挂进 ChatGPT 的编辑器。
 *
 * 传的是内存里的字节而不是磁盘路径 —— 这样能保留**原始文件名**：
 * 我们在服务器上给附件起的存盘名是随机串（防路径穿越），直接拿它去传，
 * ChatGPT 那边和同事看到的就会是一串乱码文件名。
 *
 * 怎么算挂好了：实测附件卡片出现之后，DOM 结构在 10 秒内一个字节都不变
 * （12MB 的文件也一样），发送键全程可用、也没有 aria-busy 之类的状态位。
 * 所以"文件名出现在编辑器里"就是可用的完成信号，后面再留一小段静默，
 * 防止文件特别大时卡片先出来、字节还在路上。
 */
async function attachFiles(files) {
  await page.setInputFiles(
    SEL.file,
    files.map((f) => ({
      name: f.name || "文件",
      mimeType: f.mime || "application/octet-stream",
      buffer: f.buffer,
    })),
  );

  const names = files.map((f) => f.name).filter(Boolean);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const missing = await page.evaluate((ns) => {
      const box = document.querySelector("form");
      const text = box ? box.innerText : "";
      return ns.filter((n) => !text.includes(n));
    }, names);
    if (!missing.length) {
      await page.waitForTimeout(1200); // 落地余量
      return;
    }
    await page.waitForTimeout(300);
  }
  throw new RelayError("SELECTOR", "附件没能挂进 ChatGPT 的输入框（界面可能改版了）");
}

async function doSend({ chatUrl, text, onProgress, uploads }) {
  await acquirePage();

  const target = chatUrl || projectUrl();
  if (!normalize(page.url()).startsWith(normalize(target))) {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    // 等输入框可用即可，不固定空等。冷启动时页面渲染慢，给足时间
    await waitForAny(SEL.input, 40000);
  }

  if (!(await checkReady())) {
    if (status.state === "needs-login") {
      throw new RelayError("NEEDS_LOGIN", "ChatGPT 登录已过期，需在你的 Chrome 里重新登录");
    }
    throw new RelayError("CHALLENGE", status.detail || "被风控拦截");
  }

  if (!chatUrl) await ensureFreshChat();

  const before = await assistantSnapshot();

  // #prompt-textarea 是 ProseMirror 富文本：直接设 textContent 不会触发 React
  // 更新，必须走 execCommand("insertText") 才能让发送按钮亮起来。
  const input = await waitForAny(SEL.input);

  // 先挂附件再打字：挂载会让编辑器重绘，先打字的话刚插进去的文本可能被冲掉
  if (uploads?.length) await attachFiles(uploads);

  await input.loc.click();
  await page.evaluate((t) => {
    const box = document.querySelector("#prompt-textarea, div.ProseMirror[contenteditable='true']");
    if (!box) throw new Error("找不到输入框");
    box.focus();
    if (box.textContent.trim()) document.execCommand("selectAll");
    document.execCommand("insertText", false, t);
  }, text);

  await page.waitForTimeout(400);

  if (!(await clickAny(SEL.send))) {
    await input.loc.press("Enter"); // 兜底：回车发送
  }

  const { text: reply, images } = await waitReply(before, onProgress);
  const files = await collectFiles();

  // 回传这次发送落定的对话地址。新会话首条消息时，它就是 ChatGPT 新生成的 URL。
  const now = normalize(page.url());
  return {
    reply,
    images,
    files,
    chatUrl: now.includes("/c/") ? now : chatUrl || null,
  };
}

// 轮询间隔与"判定为写完"所需的连续稳定次数。乘积就是这个版本的静默窗口：
// 500ms × 5 = 2.5s。调小时流式更细腻，但页面上的求值次数会同比上升。
const POLL_MS = 500;
const STABLE_TICKS = 5;

// 停止按钮还挂着时的静默窗口（500ms × 20 = 10s）。
// 实测 ChatGPT 的 SPA 会出现停止按钮卡住、不换回发送态的情况 ——
// 回复早就写完了，按钮还写着"停止回答"，重载页面才恢复。
// 旧写法拿它当硬条件（按钮在就永远不算完），那种页面里每条回复都要空等到
// 180s 超时才回来。所以它只能延长等待，不能一票否决。
const STUCK_TICKS = 20;

/**
 * 等回复结束。判定用**消息计数**而不是文本比较 ——
 * 文本比较在同一句话问两次时会失效（新旧回复文本相同 → 条件恒不成立 →
 * 超时后把上一条旧回复当成新回复返回）。这是上一版真实存在的 bug。
 *
 * onProgress 是流式的出口：ChatGPT 的正文是逐字落到 DOM 里的，所以每轮
 * 只要文本变了就把"到目前为止的全部文本"往外推一次，前端就有字长出来的效果。
 * 推的是全量而非增量 —— 增量一旦丢一条，后面就全错位了，全量天然可重放。
 */
async function waitReply(before, onProgress, timeout = 180000) {
  const deadline = Date.now() + timeout;
  let lastSig = null;
  let lastSnap = null;
  let stable = 0;
  let pushed = null; // 上一次推出去的文本，用来去重

  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS);

    const snap = await assistantSnapshot();
    if (snap.count <= before.count) {
      stable = 0; // 新回复还没出现
      lastSig = null;
      lastSnap = null;
      continue;
    }

    // 签名含图片数量：纯图片回复（生成图）文本是空的，只看文本会误判成"没有回复"
    const sig = JSON.stringify([snap.last, snap.images.length]);
    const hasContent = snap.last.length > 0 || snap.images.length > 0;

    // 正文开始落了就往外推。纯图片回合文本为空，推空串只会让前端闪一下，
    // 所以那种情况仍然留给"正在思考"标识，不推。
    if (snap.last && snap.last !== pushed) {
      pushed = snap.last;
      onProgress?.({ text: snap.last });
    }

    // 加载动画在，说明页面真的还在动 —— 这种情况绝不算完。
    // 只有它不在时，静默才计数。
    if (hasContent && sig === lastSig && !snap.loading) stable++;
    else stable = 0;

    lastSig = sig;
    lastSnap = snap;
    if (stable >= (snap.stop ? STUCK_TICKS : STABLE_TICKS)) {
      return { text: snap.last, images: snap.images };
    }
  }

  // 超时但有新内容：把已生成的交给用户，好过什么都不给。
  // lastSnap 为空表示压根没等到新回复 —— 绝不能退回旧回复。
  if (lastSnap && (lastSnap.last || lastSnap.images.length)) {
    return { text: lastSnap.last, images: lastSnap.images };
  }
  throw new RelayError("TIMEOUT", "等待 ChatGPT 回复超时");
}

/**
 * 排进队列。立即返回 { queued, done }：
 *  - queued：这条进来时前面有几条在等（前端显示「前面还有 N 条」用这个）
 *  - done：到回复取回（或失败）才 resolve，resolve 出 { reply, chatUrl }
 * 一次生成可能要几分钟，所以调用方不要 await done 再响应 HTTP。
 *
 * onProgress 会在生成过程中被反复调用（{ text }，全量文本），用来做流式预览。
 * 它只往上报，不参与落盘 —— 落盘的永远是 done 里的最终结果。
 */
export function send({ chatUrl = null, text, userKey, sessionId, onProgress, files = [] }) {
  const queued = queue.length;
  const item = { userKey, sessionId, enqueuedAt: Date.now() };
  queue.push(item);
  onQueueChange?.();

  const done = enqueue(async () => {
    const i = queue.indexOf(item);
    if (i >= 0) queue.splice(i, 1);
    onQueueChange?.();
    status.busyUser = userKey;
    status.busySessionId = sessionId;
    status.lastError = null;
    try {
      return await doSend({ chatUrl, text, onProgress, uploads: files });
    } catch (e) {
      status.lastError = e.message;
      if (e instanceof RelayError) throw e;
      throw new RelayError("NAV", e.message);
    } finally {
      status.busyUser = null;
      status.busySessionId = null;
      onQueueChange?.();
    }
  });

  return { queued, done };
}
