// 本机配置的读取口。config.json（不进版本库）为主，环境变量优先。
//
// 为什么要多这一层，而不是全靠 .bat 里 set —— 实测出来的两条：
//
//  1. .bat 必须是 CRLF 换行。cmd.exe 按 512 字节分块解析批处理文件，只有 LF 的话
//     它会和行首失去同步，把每行开头几个字符当成命令执行（实测：整段 rem 注释
//     都被拆成命令跑了一遍）。
//  2. 换行修对之后，`set "VAR=中文…"` **仍然**会被解析坏：实测含中文的赋值行被切成
//     残句、连结尾引号都保不住。`echo 中文` 倒是能正常显示（配合 chcp 65001），
//     但赋值不行 —— 而联系方式恰恰是个要赋给变量的值。
//
// JSON 天生 UTF-8，中文放这儿没有这些问题。于是 .bat 退化成纯 ASCII 的启动器，
// 用任何编辑器改都不会坏。
//
// 环境变量仍然优先：容器、CI、临时改端口这些场景用起来更顺手。
import { readFileSync } from "node:fs";
import path from "node:path";

const FILE = path.join(import.meta.dirname, "config.json");

let cached = null;

/** 读配置。首次调用读盘，之后走缓存 —— 改了 config.json 要重启服务。 */
export function config() {
  if (cached) return cached;

  let file = {};
  try {
    file = JSON.parse(readFileSync(FILE, "utf-8"));
  } catch {
    // 没有配置文件就用环境变量与默认值，不是错误
  }

  const pick = (key, fallback = "") => {
    const env = process.env[key];
    if (env !== undefined && env !== "") return String(env).trim();
    const v = file[key];
    return v === undefined || v === null || v === "" ? fallback : String(v).trim();
  };

  cached = {
    projectUrl: pick("CHATGPT_PROJECT_URL"),
    adminContact: pick("ADMIN_CONTACT"),
    port: Number(pick("PORT", "8765")),
    host: pick("HOST", "0.0.0.0"),
  };
  return cached;
}
