// 工作台前端。状态、会话列表、新消息、通知都由 SSE 推送；只有"拉某个会话的完整历史"
// 走一次性 HTTP 请求（切会话时用）。
//
// 两处刻意的处理：
//  - 消息增量渲染，不整段重绘（重绘会清掉选中文字和滚动位置）
//  - 轮询是异步的，切换会话时必须校验响应回来时是否还在同一个会话

const $ = (id) => document.getElementById(id);

// 没选中任何会话时，顶栏显示的名字
const APP_NAME = "ChatGPT 网页中转站";

const sessionsEl = $("sessions");
const stream = $("stream");
const empty = $("empty");
const thinking = $("thinking");
const thinkingText = $("thinkingText");
const input = $("input");
const sendBtn = $("send");
const clearBtn = $("clear");
const newSessionBtn = $("newSession");
const titleEl = $("title");
const statusEl = $("status");
const statusText = statusEl.querySelector(".status-text");
const bell = $("bell");
const bellBadge = $("bellBadge");
const noticesEl = $("notices");
const noticesBody = $("noticesBody");
const gate = $("gate");
const gateForm = $("gateForm");
const gateErr = $("gateErr");
const gateStatus = $("gateStatus");
const gName = $("gName");
const gPass = $("gPass");
const gPass2 = $("gPass2");
const confirmField = $("confirmField");

let me = null;
let sessions = [];
let sessionSig = "";
let currentSid = null;
let shown = 0;
let lastTotal = 0;
let connState = "ready";
let busySessionId = null;
let noticeCurrent = null;
let noticeEvents = [];
let es = null;
let liveEl = null; // 正在长出来的那条回复（流式预览）
let liveText = "";

// ---------- 请求 ----------

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (r.status === 401) {
    const e = new Error("unauthorized");
    e.unauthorized = true;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`);
  return data;
}

const post = (p, body) => api(p, { method: "POST", body: JSON.stringify(body || {}) });

// ---------- 页内对话框 ----------
//
// 一律不用原生 confirm()/alert()。原因和界面好看无关，是它们**根本弹不出来**：
// 服务器那侧的 Playwright 用 connectOverCDP 连着同事这个浏览器，挂的正是他正在
// 用的默认上下文；Playwright 在没有 dialog 处理器时会自动关掉页面的原生对话框。
// 实测：前台标签页里 confirm() 7 毫秒就返回 false，没有人点过。
// 后果就是点了删除毫无反应、报错也一声不响 —— 所以确认与提示都必须自绘。

/** 自绘确认框。resolve true 表示用户点了确认。 */
function ask({ title, body, okText = "确定", cancelText = "取消" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";

    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");

    const h = document.createElement("h2");
    h.textContent = title;

    const p = document.createElement("p");
    p.textContent = body; // 可能含换行，交给 CSS 的 pre-wrap 呈现

    const actions = document.createElement("div");
    actions.className = "sheet-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "quiet";
    cancel.textContent = cancelText;

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "primary";
    ok.textContent = okText;

    const close = (v) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(v);
    };
    // 只管 Esc；确认键交给获得焦点的按钮自己处理
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
    };

    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    // 点遮罩等于取消，点卡片内部不关
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKey);

    actions.append(cancel, ok);
    sheet.append(h, p, actions);
    overlay.append(sheet);
    document.body.append(overlay);
    ok.focus();
  });
}

/** 轻提示，替代 alert（同样会被自动关掉，等于没提示）。 */
function toast(text) {
  let wrap = document.getElementById("toasts");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toasts";
    wrap.className = "toast-wrap";
    document.body.append(wrap);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  wrap.append(el);
  setTimeout(() => el.remove(), 7000);
}

// ---------- 登录 ----------

let gateMode = "login";

function setGateMode(mode) {
  gateMode = mode;
  $("tabLogin").classList.toggle("is-on", mode === "login");
  $("tabRegister").classList.toggle("is-on", mode === "register");
  confirmField.hidden = mode !== "register";
  $("gateSubmit").textContent = mode === "login" ? "登录" : "注册并进入";
  gPass.autocomplete = mode === "login" ? "current-password" : "new-password";
  document.querySelector(".hint-login").hidden = mode !== "login";
  document.querySelector(".hint-register").hidden = mode !== "register";
  gateErr.hidden = true;
}

$("tabLogin").addEventListener("click", () => setGateMode("login"));
$("tabRegister").addEventListener("click", () => setGateMode("register"));

function showGate() {
  if (es) {
    es.close();
    es = null;
  }
  me = null;
  document.body.classList.remove("authed");
  gate.hidden = false;
  setGateMode("login");
  gName.focus();
}

gateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  gateErr.hidden = true;

  const name = gName.value.trim();
  const pass = gPass.value;
  if (!name || !pass) return showGateErr("账号和密码都要填");

  // 密码没有找回通道，手滑一次就永久锁死这个账号，所以注册要输两遍
  if (gateMode === "register" && pass !== gPass2.value) {
    return showGateErr("两次输入的密码不一致");
  }

  try {
    await post(gateMode === "login" ? "/api/login" : "/api/register", {
      name,
      password: pass,
    });
    me = { name };
    gPass.value = "";
    gPass2.value = "";
    await enterApp();
  } catch (err) {
    showGateErr(err.message);
  }
});

function showGateErr(msg) {
  gateErr.textContent = msg;
  gateErr.hidden = false;
}

// 登录页也要能看到服务器状态，否则连不上时只能干瞪眼
async function pollGateStatus() {
  if (document.body.classList.contains("authed")) return;
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    gateStatus.textContent =
      h.state === "ready" ? "服务器已连接 ChatGPT" : h.detail || "服务器未就绪";
    gateStatus.classList.toggle("is-alert", h.state !== "ready");
  } catch {
    gateStatus.textContent = "连不上服务器";
    gateStatus.classList.add("is-alert");
  }
}
setInterval(pollGateStatus, 5000);

// ---------- 进入应用 ----------

async function enterApp() {
  document.body.classList.add("authed");
  gate.hidden = true;
  $("whoami").textContent = me.name;
  currentSid = null;
  sessionSig = "";
  clearStream();
  connectEvents();
  autosize(); // 此刻界面已可见，补一次高度计算
  input.focus();
}

$("logout").addEventListener("click", async () => {
  await post("/api/logout").catch(() => {});
  location.reload();
});

// ---------- SSE ----------

function connectEvents() {
  if (es) es.close();
  es = new EventSource("/api/events");

  es.addEventListener("snapshot", async (e) => {
    const d = JSON.parse(e.data);
    me = d.me;
    if (d.config) adminContact = d.config.adminContact || "";
    $("whoami").textContent = me.name;
    paintStatus(d.status);
    applyNotices(d.notices);
    applySessions(d.sessions || []);
    // 首次连上自动打开最近一个会话
    if (!currentSid && sessions.length) await selectSession(sessions[0].id);
  });

  es.addEventListener("status", (e) => paintStatus(JSON.parse(e.data)));

  es.addEventListener("sessions", (e) => applySessions(JSON.parse(e.data).sessions || []));

  es.addEventListener("notices", () => refreshNotices().catch(() => {}));

  es.addEventListener("cleared", (e) => {
    if (JSON.parse(e.data).sessionId === currentSid) clearStream();
  });

  // 生成过程中的正文片段。只认当前会话，切走了就不理。
  es.addEventListener("streaming", (e) => {
    const d = JSON.parse(e.data);
    if (d.sessionId !== currentSid) return;
    paintLive(d.text);
  });

  // 只当"有新消息"的信号用，具体内容重新按 since 拉一次 —— 这样不会和
  // 切会话时的全量拉取抢跑出重复或漏条
  es.addEventListener("message", (e) => {
    const d = JSON.parse(e.data);
    if (d.sessionId === currentSid) pollMessages().catch(() => {});
  });

  es.onerror = async () => {
    // EventSource 不暴露状态码，只能补一次探测区分"服务不可达"与"登录失效"
    try {
      const r = await fetch("/api/me");
      if (r.status === 401) {
        showGate(); // showGate 会 close，避免变成 401 死循环
        return;
      }
    } catch {
      /* 服务器不可达：EventSource 会自己重连 */
    }
  };
}

// ---------- 会话 ----------

function applySessions(list) {
  // 列表没变就不重绘，免得频繁重建 DOM 打断 hover 与点击
  const sig = list.map((s) => `${s.id}|${s.title}|${s.pending}|${s.updatedAt}`).join("~");
  if (sig === sessionSig) return;
  sessionSig = sig;
  sessions = list;
  renderSessions();
  const s = currentSession();
  if (s) titleEl.textContent = s.title || "新会话";
}

function renderSessions() {
  if (!sessions.length) {
    sessionsEl.replaceChildren(
      Object.assign(document.createElement("div"), {
        className: "session-empty",
        textContent: "还没有会话。在右边写下第一句就会自动建一个。",
      }),
    );
    return;
  }

  sessionsEl.replaceChildren(
    ...sessions.map((s) => {
      // 用 div 包住两个按钮：会话项本身若是 button，就不能再嵌套删除按钮
      const row = document.createElement("div");
      row.className = "session" + (s.id === currentSid ? " is-on" : "");

      const main = document.createElement("button");
      main.type = "button";
      main.className = "session-main";

      const name = document.createElement("span");
      name.className = "session-name";
      name.textContent = s.title || "新会话";
      main.append(name);

      const meta = document.createElement("span");
      meta.className = "session-meta";
      if (s.pending) {
        const d = document.createElement("span");
        d.className = "mini-dot";
        meta.append(d);
      }
      const t = document.createElement("span");
      t.textContent = relTime(s.updatedAt);
      meta.append(t);
      main.append(meta);

      main.addEventListener("click", () => selectSession(s.id));
      row.append(main);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "session-del";
      del.textContent = "×";
      del.title = "删除会话";
      del.setAttribute("aria-label", `删除会话：${s.title || "新会话"}`);
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        removeSession(s);
      });
      row.append(del);

      return row;
    }),
  );
}

async function removeSession(s) {
  const ok = await ask({
    title: `删除会话「${s.title || "新会话"}」？`,
    body: s.hasChat
      ? "ChatGPT 里对应的对话也会一并删除，不可撤销。"
      : "这个会话还没在 ChatGPT 里建立对话，只删本地记录。",
    okText: "删除",
  });
  if (!ok) return;

  try {
    const r = await api(`/api/sessions/${s.id}`, { method: "DELETE" });

    // 远程没删掉要说出来，别让用户以为项目里也清干净了
    if (r.remote && r.remote.ok === false) {
      toast(`本地已删除，但 ChatGPT 那边没删掉：${r.remote.reason}`);
    }

    if (currentSid === s.id) {
      currentSid = null;
      clearStream();
      titleEl.textContent = APP_NAME;
    }
    sessionSig = "";
  } catch (e) {
    if (!e.unauthorized) toast(e.message);
  }
}

function relTime(ts) {
  const d = new Date(ts || Date.now());
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return "昨天";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

const currentSession = () => sessions.find((s) => s.id === currentSid) || null;

async function selectSession(sid) {
  currentSid = sid;
  clearStream();
  renderSessions();
  const s = currentSession();
  titleEl.textContent = s ? s.title || "新会话" : APP_NAME;
  await pollMessages().catch(() => {});
  document.body.classList.remove("nav-open");
  input.focus();
}

function clearStream() {
  stream.querySelectorAll(".msg").forEach((n) => n.remove());
  shown = 0;
  lastTotal = 0;
  empty.style.display = "";
  thinking.hidden = true;
  liveEl = null; // 上面按 .msg 一并删掉了，引用必须跟着清，否则会用到一个死节点
  liveText = "";
}

// 新建会话：不立刻建空会话，等真的发出第一句再建（避免一堆空会话）
newSessionBtn.addEventListener("click", () => {
  currentSid = null;
  clearStream();
  renderSessions();
  titleEl.textContent = "新会话";
  document.body.classList.remove("nav-open");
  input.focus();
});

// ---------- 消息 ----------

function fmtSize(n) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const FILE_ICON = `<svg viewBox="0 0 20 20" width="15" height="15" fill="none"
  stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
  <path d="M11.5 2.5H5.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6.5z"/>
  <path d="M11.5 2.5v4h4"/></svg>`;

function renderMessage(m, sid) {
  const el = document.createElement("article");
  el.className = "msg " + (m.role === "user" ? "user" : "assistant");
  if (m.error) el.classList.add("error");

  if (m.role === "user") {
    const stamp = document.createElement("span");
    stamp.className = "stamp";
    stamp.textContent = new Date(m.ts || Date.now()).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    el.append(stamp);
  }

  const body = document.createElement("div");
  body.className = "body";
  body.textContent = m.text; // textContent：绝不把内容当 HTML 解析
  el.append(body);

  // 图片由我们自己的服务转发（ChatGPT 的原始地址要登录态，直链打不开）
  if (m.images?.length) {
    const wrap = document.createElement("div");
    wrap.className = "msg-images";
    for (const im of m.images) {
      const img = document.createElement("img");
      img.src = `/api/sessions/${sid}/images/${im.file}`;
      img.alt = im.alt || "图片";
      img.loading = "lazy";
      wrap.append(img);
    }
    el.append(wrap);
  }

  // 生成的文件：下载块
  if (m.files?.length) {
    const wrap = document.createElement("div");
    wrap.className = "msg-files";
    for (const f of m.files) {
      const row = document.createElement("div");
      row.className = "file-block";

      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.innerHTML = FILE_ICON; // 固定字面量，不含用户内容
      row.append(icon);

      const nm = document.createElement("span");
      nm.className = "file-name";
      nm.textContent = f.name || "文件";
      row.append(nm);

      const sz = document.createElement("span");
      sz.className = "file-size";
      sz.textContent = fmtSize(f.size);
      row.append(sz);

      const a = document.createElement("a");
      a.className = "file-dl";
      a.href = `/api/sessions/${sid}/files/${f.file}`;
      a.setAttribute("download", "");
      a.textContent = "下载";
      row.append(a);

      wrap.append(row);
    }
    el.append(wrap);
  }

  // 有东西没取到就说出来，别让用户以为回复就是空的
  if (m.failedAttachments) {
    const warn = document.createElement("div");
    warn.className = "msg-warn";
    warn.textContent = `有 ${m.failedAttachments} 个附件未能获取`;
    el.append(warn);
  }

  return el;
}

const nearBottom = () =>
  stream.scrollHeight - stream.scrollTop - stream.clientHeight < 160;

/**
 * 流式预览：把正在生成的正文画在消息流末尾。
 *
 * 每来一片就整段替换，不做增量拼接 —— 服务端推的本来就是全量，替换最简单也
 * 最不容易错位。真正的落定消息到了（appendMessages）就把这个临时节点撤掉。
 */
function paintLive(text) {
  if (!currentSid || !text) return;
  const stick = nearBottom();

  if (!liveEl) {
    liveEl = document.createElement("article");
    liveEl.className = "msg assistant live";
    const body = document.createElement("div");
    body.className = "body";
    liveEl.append(body);
    stream.append(liveEl);
  }
  liveEl.querySelector(".body").textContent = text;
  liveText = text;

  empty.style.display = "none";
  refreshThinking(); // 正文已经出来了，就不该再说"正在思考"
  if (stick) stream.scrollTop = stream.scrollHeight;
}

function dropLive() {
  liveEl?.remove();
  liveEl = null;
  liveText = "";
}

function appendMessages(list) {
  const stick = nearBottom();
  dropLive(); // 落定消息来了，临时预览让位（它的内容就在这条里）
  stream.append(...list.map((m) => renderMessage(m, currentSid)));
  stream.append(thinking); // 思考标识永远排在消息之后
  shown += list.length;
  empty.style.display = shown ? "none" : "";
  refreshThinking();
  if (stick) stream.scrollTop = stream.scrollHeight;
}

/**
 * 消息区里的"正在思考"标识。区分两件事：
 *  你是当前这条在生成，还是在排队等别人 —— 两者等待时间差很多，得说清楚。
 */
function refreshThinking() {
  const s = currentSession();
  const pending = !!s?.pending;
  // 正文已经在往外蹦了，就不能还挂着"正在思考" —— 那是"一个字都还没有"时才说的话
  thinking.hidden = !pending || !!liveText;
  if (!pending) return;
  thinkingText.textContent =
    busySessionId === currentSid ? "正在思考…" : "排队中，等待前面的消息…";
  if (nearBottom()) stream.scrollTop = stream.scrollHeight;
}

/**
 * 只在"切会话"和"收到新消息通知"时调用。
 *
 * 同一时刻只允许一次在飞。这两条路径会撞在一起：发送成功后自己拉一次，同时
 * 服务端推来的 message 事件又触发一次；两次并发会在**更新 lastTotal 之前**
 * 各自读一遍 old 值，于是按同一个 since 取回同一批消息，各追加一遍 ——
 * 界面上整个回合翻倍。所以并发的后来者不重复取，只记个标记，
 * 等在飞的那次结束后再补一次（那一批可能是它在飞的时候才落盘的）。
 */
let pollInFlight = null;
let pollAgain = false;

async function pollMessages() {
  if (pollInFlight) {
    pollAgain = true;
    return pollInFlight;
  }

  pollInFlight = (async () => {
    const sid = currentSid;
    if (!sid) return;

    let d = await api(`/api/sessions/${sid}/messages?since=${lastTotal}`);
    if (currentSid !== sid) return; // 用户切走了，丢弃这份响应

    if (d.total < lastTotal) {
      // 会话在别处被清了：从头重拉
      d = await api(`/api/sessions/${sid}/messages?since=0`);
      if (currentSid !== sid) return;
      clearStream();
    }
    if (d.messages.length) appendMessages(d.messages);
    lastTotal = d.total;
  })();

  try {
    await pollInFlight;
  } finally {
    pollInFlight = null;
    if (pollAgain) {
      pollAgain = false;
      await pollMessages();
    }
  }
}

// ---------- 状态 ----------

function paintStatus(s) {
  connState = s.state;
  busySessionId = s.busySessionId || null;
  statusEl.className = "status";

  let text = "已连接";
  if (s.state === "starting") text = "正在启动…";
  else if (s.state !== "ready") {
    text = s.detail || "未连接";
    statusEl.classList.add("is-alert");
  } else if (s.busySessionId && s.busySessionId === currentSid) {
    text = "正在生成…";
    statusEl.classList.add("is-working");
  } else if (s.myAhead > 0) {
    // 自己那条在队列里的位置，比全局队列深度更有意义
    text = `排队中，前面还有 ${s.myAhead} 条`;
    statusEl.classList.add("is-working");
  }

  // 顶栏放不下完整说明（故障详情里有 Windows 路径这种长串），CSS 会截断成省略号，
  // 完整内容挂 title 上；信封面板里本来就有一份全文。
  statusText.textContent = text;
  statusText.title = text;
  refreshSendBtn();
  refreshThinking();
}

function refreshSendBtn() {
  const busyHere = !!(currentSid && currentSession()?.pending);
  // 只带附件不写字，也是合法的一条消息
  const hasSomething = !!input.value.trim() || pendingFiles.length > 0;
  sendBtn.disabled = connState !== "ready" || busyHere || !hasSomething;
}

// ---------- 通知 ----------

const readAt = () => Number(localStorage.getItem("noticesReadAt") || 0);

// 联系方式由服务端下发（ADMIN_CONTACT 环境变量）。没配就是空串，那一行不显示 ——
// 开源版本里绝不能写死一个人名。
let adminContact = "";

let feedbackDone = false; // 提交过就置灰，避免同一条被反复刷

async function submitFeedback() {
  try {
    await post("/api/feedback");
    feedbackDone = true;
    renderNotices();
  } catch (e) {
    if (!e.unauthorized) toast(`反馈没提交成功：${e.message}`);
  }
}

async function refreshNotices() {
  applyNotices(await api("/api/notices"));
}

function applyNotices(d) {
  if (!d) return;
  // 状态变了就是另一回事了，允许再反馈一次
  if (noticeCurrent?.state !== d.current?.state) feedbackDone = false;
  noticeCurrent = d.current;
  noticeEvents = d.events || [];
  renderNotices();
  updateBadge();
}

function updateBadge() {
  const unread = noticeEvents.filter((e) => e.ts > readAt()).length;
  const broken = noticeCurrent && noticeCurrent.state !== "ready";
  bellBadge.hidden = !(unread || broken);
}

function renderNotices() {
  const parts = [];

  // 当前故障置顶，并带上排查步骤 —— 同事看不到服务器终端，只能靠这里
  if (noticeCurrent && noticeCurrent.state !== "ready") {
    const box = document.createElement("div");
    box.className = "notice is-error";
    const t = document.createElement("div");
    t.className = "notice-text";
    t.textContent = noticeCurrent.detail || "服务器未就绪";
    box.append(t);

    if (noticeCurrent.steps?.length) {
      const ul = document.createElement("ul");
      ul.className = "notice-steps";
      for (const s of noticeCurrent.steps) {
        const li = document.createElement("li");
        li.textContent = s;
        ul.append(li);
      }
      box.append(ul);
    }
    parts.push(box);
  }

  if (!noticeEvents.length && !parts.length) {
    const e = document.createElement("div");
    e.className = "notices-empty";
    e.textContent = "暂无通知。";
    parts.push(e);
  } else {
    for (const ev of noticeEvents) {
      const box = document.createElement("div");
      box.className = "notice" + (ev.level === "error" ? " is-error" : "");
      const t = document.createElement("div");
      t.className = "notice-time";
      t.textContent = new Date(ev.ts).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const m = document.createElement("div");
      m.className = "notice-text";
      m.textContent = ev.text;
      box.append(t, m);
      parts.push(box);
    }
  }

  // 反馈：把此刻这条维护消息原样存档，管理员照着就能排查
  const actions = document.createElement("div");
  actions.className = "notice-actions";
  const fb = document.createElement("button");
  fb.type = "button";
  fb.className = "feedback-btn";
  // 有故障时是"这个问题"，没有故障时就不该说"这个"
  const hasFault = noticeCurrent && noticeCurrent.state !== "ready";
  fb.textContent = feedbackDone
    ? "已反馈，管理员会看到"
    : hasFault
      ? "反馈这个问题"
      : "反馈给管理员";
  fb.disabled = feedbackDone;
  fb.addEventListener("click", submitFeedback);
  actions.append(fb);
  parts.push(actions);

  if (adminContact) {
    const note = document.createElement("div");
    note.className = "notice-note";
    note.textContent = adminContact;
    parts.push(note);
  }

  noticesBody.replaceChildren(...parts);
}

bell.addEventListener("click", (e) => {
  e.stopPropagation();
  noticesEl.hidden = !noticesEl.hidden;
  if (!noticesEl.hidden) {
    localStorage.setItem("noticesReadAt", String(Date.now()));
    updateBadge();
  }
});

document.addEventListener("click", (e) => {
  if (!noticesEl.hidden && !noticesEl.contains(e.target)) noticesEl.hidden = true;
});

// ---------- 附件 ----------
//
// 上传和消息走同一个请求：文件在这儿读成 base64，随 body 一起交给服务器。
// 不做"先传文件拿 id、再引用 id 发送"那套 —— 新会话的第一条消息要先把文件
// 传到一个还不存在的会话上，等于凭空多出一个暂存区和一套过期回收，
// 换来的只是请求体小一点，不划算。

// 与 server.js 里的上限一致。服务端才是权威，这里只为早一点给出反馈。
const MAX_FILES = 6;
const MAX_UPLOAD_MB = 25;

let pendingFiles = []; // [{ file, name, size, mime }]

const attachList = $("attachList");
const filePick = $("filePick");

function renderAttach() {
  attachList.hidden = !pendingFiles.length;
  attachList.replaceChildren(
    ...pendingFiles.map((f, i) => {
      const chip = document.createElement("span");
      chip.className = "attach";

      const nm = document.createElement("span");
      nm.className = "attach-name";
      nm.textContent = f.name;
      nm.title = f.name;

      const sz = document.createElement("span");
      sz.className = "attach-size";
      sz.textContent = fmtSize(f.size);

      const x = document.createElement("button");
      x.type = "button";
      x.className = "attach-x";
      x.textContent = "×";
      x.title = "移除";
      x.setAttribute("aria-label", `移除附件：${f.name}`);
      x.addEventListener("click", () => {
        pendingFiles.splice(i, 1);
        renderAttach();
        refreshSendBtn();
      });

      chip.append(nm, sz, x);
      return chip;
    }),
  );
}

/** 收下一批文件。超限的挑出来说清楚，而不是静默丢掉。 */
function addFiles(list) {
  const total = () => pendingFiles.reduce((n, p) => n + p.size, 0);
  for (const f of list) {
    if (pendingFiles.length >= MAX_FILES) {
      toast(`一条消息最多带 ${MAX_FILES} 个附件`);
      break;
    }
    if (f.size > MAX_UPLOAD_MB * 1024 * 1024) {
      toast(`「${f.name}」超过 ${MAX_UPLOAD_MB} MB，没加进来`);
      continue;
    }
    if (total() + f.size > MAX_UPLOAD_MB * 1024 * 1024) {
      toast(`附件加起来超过 ${MAX_UPLOAD_MB} MB 了，后面的没加进来`);
      break;
    }
    if (pendingFiles.some((p) => p.file === f || (p.name === f.name && p.size === f.size))) {
      continue; // 同一个文件拖两次
    }
    pendingFiles.push({ file: f, name: f.name, size: f.size, mime: f.type || "" });
  }
  renderAttach();
  refreshSendBtn();
}

const readAsBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    // readAsDataURL 出来是 data:<mime>;base64,<正文>，只要逗号后面那段
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error(`读不了「${file.name}」`));
    r.readAsDataURL(file);
  });

async function filesPayload() {
  const out = [];
  for (const p of pendingFiles) {
    out.push({ name: p.name, mime: p.mime, b64: await readAsBase64(p.file) });
  }
  return out;
}

$("attach").addEventListener("click", () => filePick.click());

filePick.addEventListener("change", () => {
  addFiles(filePick.files);
  filePick.value = ""; // 不清空的话，再选同一个文件不会触发 change
});

// 拖进页面任意位置都能收，顺手把浏览器"打开这个文件"的默认行为挡掉
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (++dragDepth === 1) document.body.classList.add("dragging");
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

// 截图直接粘贴进来
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

// ---------- 发送 ----------

async function submit() {
  const text = input.value.trim();
  if ((!text && !pendingFiles.length) || connState !== "ready") return;
  if (currentSid && currentSession()?.pending) return;

  // 读文件是同步耗时的（大文件几百毫秒起步），先把按钮按住再说，
  // 否则用户会以为没点上，反复点。
  const sending = pendingFiles.slice();
  let payload;
  if (sending.length) {
    sendBtn.disabled = true;
    sendBtn.textContent = "上传中…";
  }
  try {
    payload = { text, files: await filesPayload() };
  } catch (e) {
    toast(e.message);
    sendBtn.textContent = "发送";
    refreshSendBtn();
    return;
  }
  sendBtn.textContent = "发送";

  input.value = "";
  autosize();
  sendBtn.disabled = true;

  try {
    if (currentSid) {
      await post(`/api/sessions/${currentSid}/send`, payload);
    } else {
      // 原子：建会话 + 发首条，避免留下一堆空会话
      const d = await post("/api/sessions", payload);
      currentSid = d.sessionId;
      clearStream();
      sessionSig = ""; // 强制刷新列表
    }
    pendingFiles = [];
    renderAttach();
    await pollMessages();
    stream.scrollTop = stream.scrollHeight;
  } catch (err) {
    if (err.unauthorized) return;
    input.value = text; // 没发出去就把内容还给用户，别弄丢
    pendingFiles = sending; // 附件同理
    renderAttach();
    autosize();
    toast(err.message);
  } finally {
    refreshSendBtn();
  }
}

// ---------- 输入区 ----------

function autosize() {
  // 不可见时 scrollHeight 为 0，照着设会把高度锁死在 0px 且之后不再重算
  if (!input.offsetParent) return;
  input.style.height = "auto";
  const max = window.innerHeight * 0.4;
  const h = input.scrollHeight;
  if (h > max) {
    input.style.height = max + "px";
    input.style.overflowY = "auto";
  } else {
    // +1：边框会让内容区比 scrollHeight 少 1px，不加会切掉最后一行底部
    input.style.height = h + 1 + "px";
    input.style.overflowY = "hidden";
  }
}

input.addEventListener("input", () => {
  autosize();
  refreshSendBtn();
});

input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;

  // 中文输入法用 Enter 选词/上屏，这一刻绝不能当成"发送" ——
  // 否则刚敲完拼音，半句话就飞出去了。isComposing 是标准信号，
  // keyCode 229 是少数浏览器与输入法不上报 isComposing 时的兜底。
  if (e.isComposing || e.keyCode === 229) return;

  if (e.shiftKey) return; // Shift + Enter 换行，写长文用

  e.preventDefault();
  submit();
});

sendBtn.addEventListener("click", submit);

clearBtn.addEventListener("click", async () => {
  if (!currentSid) return;
  const ok = await ask({
    title: "清空这个会话的记录？",
    body: "ChatGPT 那边的对话不受影响。",
    okText: "清空",
  });
  if (!ok) return;
  try {
    await post(`/api/sessions/${currentSid}/clear`);
    clearStream();
  } catch (e) {
    if (!e.unauthorized) toast(e.message);
  }
});

// 窄屏抽屉：按钮开合，点遮罩或按 Esc 关。
// 关的条件写在一处，免得三条路径各自漏掉某个状态。
const menuBtn = $("menuBtn");
const navBackdrop = $("navBackdrop");
const closeNav = () => document.body.classList.remove("nav-open");

if (menuBtn) {
  menuBtn.addEventListener("click", () => document.body.classList.toggle("nav-open"));
}
navBackdrop?.addEventListener("click", closeNav);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeNav();
});

// ---------- 启动 ----------

(async function boot() {
  setGateMode("login");
  try {
    const r = await fetch("/api/me");
    if (r.ok) {
      const u = await r.json();
      me = { name: u.name };
      adminContact = u.adminContact || "";
      await enterApp();
    } else {
      gate.hidden = false;
    }
  } catch {
    gate.hidden = false;
    gateStatus.textContent = "连不上服务器";
  }
  document.body.classList.remove("booting");
  pollGateStatus();
  autosize();
})();
