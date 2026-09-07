/**
 * Yadea_TokenCapture.js — 雅迪 H5 网关 Token 捕获（Quantumult X 重写脚本）
 *
 * 用途：打开雅迪 App（内嵌 H5 页面）时，捕获请求头 Authorization（Bearer JWT）
 *       并存入 QX 持久化存储；token 变化时弹通知，通知详情页可全选复制。
 *
 * 搭配使用：Scriptable「Yadea Car」组件的 Token 配置（有效约 1 年，
 *           App 重新登录后可能轮换，以捕获到的新 token 为准）。
 *
 * 数据流：雅迪 App H5 请求 → QX 重写拦截（响应阶段） → 本脚本 → $persistentStore + $notify
 * 注意：使用 script-response-header 类型（NE v1.7.0 实测 script-request-header
 *       不注入 $request，响应阶段两种对象都可用）。
 *
 * @author WorkBuddy
 * @updated 2026-09-07
 * @version 1.3
 */

const STORE_KEY = "yadea_h5_token";

function captureToken(headers) {
  if (!headers) return "";
  // QX 可能统一小写 header key，兼容两种取法
  const auth = headers["Authorization"] || headers["authorization"] || "";
  if (auth.indexOf("Bearer ") === 0) return auth.slice(7).trim();
  // 兜底：从 Cookie 里的 H5-Token 取
  const cookie = headers["Cookie"] || headers["cookie"] || "";
  const m = cookie.match(/H5-Token=([^;\s]+)/);
  return m ? m[1].trim() : "";
}

try {
  // 手动在 QX「脚本」页运行时没有 $request，属正常——本脚本只能由重写规则触发
  const req = typeof $request === "undefined" ? null : $request;
  if (!req || !req.headers) {
    console.log("[YadeaToken] 本次运行无 $request（手动执行属正常；若由重写触发仍出现此行，说明该 QX 版本未注入，需换捕获类型）");
  } else {
    const token = captureToken(req.headers);
    if (!token || token.length < 100) {
      // 非预期形态，静默跳过，避免误存
      console.log("[YadeaToken] 未捕获到有效 token（长度不足）");
    } else {
      const old = $persistentStore.read(STORE_KEY);
      if (old === token) {
        console.log("[YadeaToken] token 未变化，不打扰");
      } else {
        $persistentStore.write(token, STORE_KEY);
        // 变化才弹通知；通知点开后详情页可全选复制完整 token
        $notify(
          "雅迪 Token 已捕获" + (old ? "（有更新）" : ""),
          "长度 " + token.length + " · 请复制后填入 Scriptable 配置",
          token
        );
      }
    }
  }
} catch (e) {
  console.log("[YadeaToken] 捕获异常: " + e.message);
}

$done({});
