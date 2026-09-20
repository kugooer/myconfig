/******************************************
 * 中国移动 App「7日打卡分百万」自动打卡
 * capture-v2（2026-09-20）
 *
 * 活动页: https://dev.coc.10086.cn/coc/web6/dailyLoginEvent/?pageId=...&channelId=...
 * 接口:
 *   换令牌(POST, loginCheck): https://dev.coc.10086.cn/coc/user/loginCheck
 *                        响应明文 {"data":{"token":"000_<32hex>"}}，并下发
 *                        Set-Cookie: User-Token=...; Max-Age=1800
 *   查状态(POST, 明文): .../coc/activities/prize/consecutiveClockInQuery
 *                        body {"activityId":"2095709942208745472"}
 *   打卡  (POST, 加密): .../coc/activities/prize/clockIn
 *                        body {"cocEnContent":"<AES-GCM 密文>"}
 *                        header coc-aurora: <RSA 包裹的 AES 密钥>  coc-en-version: <版本>
 *
 * ★ 为什么做不成「打开 App 登录即签到」（2026-09-20 实测结论）:
 *   1) User-Token 只活 30 分钟。响应头 Max-Age=1800；实测 16:31 抓到的 4 个 token，
 *      18:02 逐个查状态全部返回 code 40 无权限 ⇒ 隔夜定时任务必然拿不到有效令牌。
 *   2) 发令牌的 loginCheck 在整份抓包中 10/10 次都由活动 WebView 页调用
 *      （UA 全为 wkwebview leadeon/12.0.2/CMCCIT，Referer 全为活动 H5 页）；
 *      原生登录 client.app.coc.10086.cn/…/fingerprintLogin 完全不碰 dev.coc.10086.cn。
 *   3) loginCheck 依赖 App 经 JSBridge 注入的一次性 SSO 票根：明文 body 为
 *      {"verifyType":18,"ext":"YZsidssolg<32hex>"}，该 ext 在整份抓包中只出现于
 *      loginCheck 请求体，无任何 HTTP 响应发放它；重放旧票 → 0130104201 登录失败。
 *   4) 对比「签到领奖」之所以能登录即签：wx.10086.cn/qwhdsso/appTokenLogin 这条链
 *      可用抓到的 App 会话程序化走完（见 CMCC_DailyBonus.js 的 ensureQwhdSession），
 *      而 dev.coc.10086.cn 侧没有等价的、可由 App 会话驱动的换票入口。
 *   ⇒ 结论：dev.coc 活动只能「开页驱动」。故本脚本把触发点放在 loginCheck 响应上：
 *     任何活动页开一次，拿到新令牌后立即补打卡（见 SevenDayInjectOnOtherPage）。
 *
 * 加密链路（逆向实测结论）:
 *   - 加密由 WASM 模块 Wheel 完成（roto 返回 [coc-aurora, cocEnContent]），
 *     无法在 QX JavaScriptCore 内重算 → 采用「冻结载荷重放」(路线 B)。
 *   - coc-aurora 是 RSA 加密的 AES 密钥，cocEnContent 是该密钥下的 AES-GCM 密文；
 *     改坏任一者服务端分别报 "RSA解密AES密钥失败" / "AES-GCM解密失败: Tag mismatch"。
 *   - 冻结载荷为「设备级」而非账号级：同一份载荷配不同账号的 User-Token 均可通过解密校验。
 *     账号维度只由 Cookie: User-Token 决定 ⇒ 只需 1 份载荷 + 每账号 1 个 User-Token。
 *
 * 鉴权: Cookie: User-Token=000_<32hex>（缺失/过期返回 code 40 无权限）
 *
 * 用法:
 *   1) 主路径（推荐）：打开任意 dev.coc 活动页 → 重写层从 loginCheck 响应抓到
 *      新 User-Token → 立即查状态 → 未签则重放打卡。7 日页自身会自动打卡，
 *      默认不在该页重复注入（见 SevenDayInjectOnOwnPage）。
 *   2) 兜底定时任务：受 30 分钟令牌限制，只有刚开过活动页后 30 分钟内跑才有意义，
 *      因此 .task 默认 enabled=false。
 *
 * $argument 支持: mode=capture|sign & DeleteCookie=true
 ******************************************/

var SevenDayEnable = true;          // 总开关
var SevenDayAutoSign = true;        // 查状态后自动补打卡
var SevenDayNotifyAlready = false;  // 全部已签时是否通知（默认静默，避免刷屏）
var SevenDayMaxTokens = 20;         // 最多保留的账号 Token 数

// —— 注入式补打卡（capture-v2 主触发路径）——
// 从 loginCheck 响应抓到新 Token 后，立即查状态 + 重放打卡。
// 活动页本身会自动打卡，注入是为了「打开任意活动页都顺带完成 7 日打卡」。
var SevenDayInjectOnOtherPage = true;   // 在「非 7 日页」的活动页上注入（推荐开启）
var SevenDayInjectOnOwnPage = false;    // 在 7 日页本身注入（页面自己会签；默认关，避免抢跑）
var SevenDayInjectTimeoutMs = 6000;     // 注入流程硬超时；超时立即放行响应，不拖死活动页
var SevenDayActivityId = "2095709942208745472";
var SevenDayPageId = "2090341662452445184";
var SevenDayChannelId = "P00000005743";
var LogDetails = false;

// 可选：给 Token 起可读名字，便于通知里区分账号（键为 User-Token 全串）
// 例: var SevenDayTokenLabels = { "000_1ede7ba0a68c4125a2b26e64d4b2e4a6": "183号" };
var SevenDayTokenLabels = {};

// 持久化 key
var K_TOKENS = "CMCC7D_Tokens";
var K_UPLINK = "CMCC7D_Uplink";
var K_LAST = "CMCC7D_LastRun";

var DEF_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148/wkwebview leadeon/12.0.2/CMCCIT";
var HOST = "https://dev.coc.10086.cn";
var API_STATUS = HOST + "/coc/activities/prize/consecutiveClockInQuery";
var API_CLOCKIN = HOST + "/coc/activities/prize/clockIn";

// 服务端错误码字典（实测）
var CODE_MAP = {
  "0": { ok: true, kind: "success", text: "打卡成功" },
  "10": { ok: true, kind: "done", text: "领取失败（业务态，通常为今日已领取）" },
  "40": { ok: false, kind: "token", text: "无权限：User-Token 失效，请重开一次活动页" },
  "50": { ok: false, kind: "payload", text: "参数不合法：coc-aurora 头缺失，请重开一次活动页" },
  "300": { ok: false, kind: "payload", text: "解密失败：冻结载荷已失效，请重开一次活动页刷新" }
};

var $nobyda = nobyda();

/********************* 工具 *********************/

// QX 运行时（JavaScriptCore）时区为 UTC，必须强制东八区
function ymd8(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  const p = n => (n < 10 ? "0" : "") + n;
  return "" + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function shortTok(t) {
  const s = String(t || "");
  return (SevenDayTokenLabels[s] || ("…" + s.slice(-5)));
}

function nowStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => (n < 10 ? "0" : "") + n;
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function readArg() {
  let raw = "";
  if (typeof $argument != "undefined" && $argument) raw = String($argument);
  else if (typeof $environment != "undefined" && $environment && $environment.params) raw = String($environment.params);
  const out = {};
  raw.split("&").forEach(kv => {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}

function httpPost(url, headers, body) {
  return new Promise(resolve => {
    $nobyda.post({ url: url, headers: headers, body: body }, (err, resp, data) => {
      resolve({ error: err ? String(err) : "", status: (resp && (resp.status || resp.statusCode)) || 0, body: data || "" });
    });
  });
}

/********************* 存储 *********************/

function loadTokens() {
  const j = safeJSON($nobyda.read(K_TOKENS) || "[]");
  return Array.isArray(j) ? j : [];
}

function saveTokens(list) {
  $nobyda.write(JSON.stringify(list.slice(-SevenDayMaxTokens)), K_TOKENS);
}

// 抓到的 User-Token 入库（去重、刷新时间戳）
function putToken(token) {
  const t = String(token || "").trim();
  if (!/^000_[0-9a-f]{32}$/i.test(t)) return false;
  const list = loadTokens();
  const hit = list.find(x => x.token === t);
  if (hit) {
    hit.lastSeen = Date.now();
    saveTokens(list);
    return false;
  }
  list.push({ token: t, firstSeen: Date.now(), lastSeen: Date.now() });
  saveTokens(list);
  return true;
}

function loadUplink() {
  return safeJSON($nobyda.read(K_UPLINK) || "null") || null;
}

function saveUplink(obj) {
  $nobyda.write(JSON.stringify(obj), K_UPLINK);
}

function buildReferer() {
  return HOST + "/coc/web6/dailyLoginEvent/index?pageId=" + SevenDayPageId + "&channelId=" + SevenDayChannelId;
}

/********************* 重写入口（请求 / 响应 分流） *********************/

function headerMap() {
  const headers = ($request && $request.headers) || {};
  const h = {};
  Object.keys(headers).forEach(k => { h[String(k).toLowerCase()] = headers[k]; });
  return h;
}

function reqUrl() {
  return String(($request && ($request.url || $request.URL)) || "");
}

// 读响应体：QX 在 script-response-body 下可能给 string 或 bodyBytes
function resBody() {
  if (typeof $response == "undefined" || !$response) return "";
  if (typeof $response.body == "string") return $response.body;
  if (typeof $response.bodyBytes != "undefined" && $response.bodyBytes) {
    try { return String.fromCharCode.apply(null, $response.bodyBytes); } catch (e) { return ""; }
  }
  return "";
}

// 统一重写入口：QX 的 script-response-body 同时带 $request 与 $response
function onRewrite() {
  const url = reqUrl();
  const h = headerMap();

  // 任何 dev.coc 请求都顺带刷新 Cookie 里的 Token（去重入库）
  const mTok = String(h["cookie"] || "").match(/User-Token=([^;]+)/i);
  if (mTok && mTok[1]) putToken(mTok[1]);

  if (typeof $response != "undefined" && $response) return handleResponse(url, h);
  return handleRequest(url, h);
}

/********************* 请求侧：抓冻结载荷 *********************/

function handleRequest(url, h) {
  // 打卡写请求：抓 body(密文) + coc-aurora 头，作为设备级冻结载荷
  if (/\/coc\/activities\/prize\/clockIn(\?|$)/i.test(url)) {
    let body = "";
    if (typeof $request.body == "string" && $request.body) body = $request.body;
    else if (typeof $request.bodyBytes != "undefined" && $request.bodyBytes) {
      try { body = String.fromCharCode.apply(null, $request.bodyBytes); } catch (e) { body = ""; }
    }
    const j = safeJSON(body);
    if (j && j.cocEnContent && h["coc-aurora"]) {
      saveUplink({
        body: body,
        aurora: String(h["coc-aurora"]),
        enVersion: String(h["coc-en-version"] || ""),
        referer: String(h["referer"] || buildReferer()),
        ua: String(h["user-agent"] || DEF_UA),
        capturedAt: Date.now()
      });
      if (LogDetails) console.log("[7日打卡] 已刷新冻结载荷, len=" + String(j.cocEnContent).length);
    } else if (LogDetails) {
      console.log("[7日打卡] clockIn 未取到密文载荷 bodyLen=" + body.length + " aurora=" + !!h["coc-aurora"]);
    }
  }
  $nobyda.done({});
}

/********************* 响应侧：loginCheck 换令牌 → 立即补打卡 *********************/

function handleResponse(url, h) {
  if (/\/coc\/user\/loginCheck(\?|$)/i.test(url)) return onLoginCheck(h);
  $nobyda.done({});
}

function onLoginCheck(h) {
  const j = safeJSON(resBody());
  const token = (j && j.data && j.data.token) ? String(j.data.token) : "";
  if (!token) {
    if (LogDetails) console.log("[7日打卡] loginCheck 未取到 token");
    $nobyda.done({});
    return;
  }

  const isNew = putToken(token);
  const label = shortTok(token);
  const onOwnPage = /dailyLoginEvent/i.test(String(h["referer"] || ""));

  if (LogDetails || isNew) {
    console.log(`[7日打卡] loginCheck 下发令牌 ${label}${isNew ? "（新入库）" : ""} 页面=${onOwnPage ? "7日页" : "其它页"}`);
  }

  if (!SevenDayEnable || !SevenDayAutoSign) { $nobyda.done({}); return; }
  if (onOwnPage && !SevenDayInjectOnOwnPage) {
    // 7 日页自身会在页面加载后自动打卡，不重复注入以免抢跑
    $nobyda.done({});
    return;
  }
  if (!onOwnPage && !SevenDayInjectOnOtherPage) { $nobyda.done({}); return; }

  const up = loadUplink();
  if (!up) {
    console.log("[7日打卡] 有新令牌但无冻结载荷，跳过注入（需先开一次 7 日页抓载荷）");
    $nobyda.done({});
    return;
  }

  // 硬超时保护：无论成败，到点必须放行响应，避免拖死活动页
  let released = false;
  const release = () => { if (!released) { released = true; $nobyda.done({}); } };
  const guard = new Promise(r => setTimeout(r, SevenDayInjectTimeoutMs));

  Promise.race([injectSign(token, up, label), guard])
    .then(release)
    .catch(e => { console.log("[7日打卡] 注入异常: " + e); release(); });
}

// 拿到刚下发的新令牌后：查状态 → 未签则重放打卡
async function injectSign(token, up, label) {
  try {
    const st = await queryStatus(token);
    if (!st.ok) {
      // 令牌是刚下发的，若仍失败多半是网络问题，静默处理不打扰
      if (LogDetails) console.log(`[7日打卡] 注入前查询失败：${st.text}`);
      return;
    }
    if (st.hasToday) {
      console.log(`[7日打卡] ${label} 今日已签（${st.list.length}天），无需注入`);
      return;
    }
    const ci = await doClockIn(token, up);
    if (ci.ok && ci.kind === "success") {
      const days = st.list.length + 1;
      console.log(`[7日打卡] ${label} 注入打卡成功（累计${days}天）`);
      $nobyda.notify("中国移动 · 7日打卡分百万", "打开活动页即完成打卡", `${label} 打卡成功（累计${days}天）`);
    } else if (ci.ok && ci.kind === "done") {
      console.log(`[7日打卡] ${label} ${ci.text}`);
    } else {
      console.log(`[7日打卡] ${label} 注入打卡失败：${ci.text}`);
      $nobyda.notify("中国移动 · 7日打卡分百万", "打卡失败", `${label} ${ci.text}`);
    }
  } catch (e) {
    console.log("[7日打卡] 注入异常: " + e);
  }
}

/********************* 兜底入口（定时任务 / 手动） *********************/
/**
 * ⚠️ User-Token 只有 30 分钟寿命，所以定时任务不能独立完成补签：
 *    隔夜跑必然全部 code 40。本入口仅在「刚开过活动页」的时间窗内有效，
 *    定位为手动触发 / 兜底，.task 默认 enabled=false。
 *    主路径是 loginCheck 响应注入（见 onLoginCheck / injectSign）。
 */

function statusHeaders(token) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": HOST,
    "Referer": buildReferer(),
    "User-Agent": DEF_UA,
    "Cookie": "User-Token=" + token
  };
}

function clockInHeaders(token, up) {
  const h = statusHeaders(token);
  h["coc-en-version"] = up.enVersion || "1586234121417629696";
  h["coc-aurora"] = up.aurora;
  if (up.ua) h["User-Agent"] = up.ua;
  if (up.referer) h["Referer"] = up.referer;
  return h;
}

async function queryStatus(token) {
  const r = await httpPost(API_STATUS, statusHeaders(token), JSON.stringify({ activityId: SevenDayActivityId }));
  if (r.error) return { ok: false, kind: "net", text: "网络错误: " + r.error, raw: r };
  const j = safeJSON(r.body);
  if (!j) return { ok: false, kind: "net", text: "响应非 JSON: " + String(r.body).slice(0, 120), raw: r };
  if (String(j.code) !== "0") {
    const c = CODE_MAP[String(j.code)];
    return { ok: false, kind: (c && c.kind) || "other", text: `查状态失败 code=${j.code} ${j.message || ""}`, raw: j };
  }
  const data = j.data || {};
  const list = Array.isArray(data.clockInDateList) ? data.clockInDateList.map(String) : [];
  return { ok: true, list: list, today: ymd8(), hasToday: list.indexOf(ymd8()) >= 0 };
}

async function doClockIn(token, up) {
  const r = await httpPost(API_CLOCKIN, clockInHeaders(token, up), up.body);
  if (r.error) return { ok: false, kind: "net", text: "网络错误: " + r.error, raw: r };
  const j = safeJSON(r.body);
  if (!j) return { ok: false, kind: "net", text: "响应非 JSON: " + String(r.body).slice(0, 120), raw: r };
  const code = String(j.code);
  const c = CODE_MAP[code] || { ok: false, kind: "other", text: `未知返回 code=${code} ${j.message || ""}` };
  return { ok: !!c.ok, kind: c.kind, text: c.text, code: code, raw: j };
}

async function main() {
  const args = readArg();
  if (String(args.DeleteCookie || "") === "true") {
    [$nobyda.write("", K_TOKENS), $nobyda.write("", K_UPLINK), $nobyda.write("", K_LAST)];
    $nobyda.notify("中国移动 · 7日打卡", "已清空凭证", "Token 列表与冻结载荷已重置，请在 App 打开一次活动页重新抓取");
    $nobyda.time();
    $nobyda.done({});
    return;
  }
  if (!SevenDayEnable) {
    $nobyda.done({});
    return;
  }

  const mode = String(args.mode || (SevenDayAutoSign ? "sign" : "sign"));
  const tokens = loadTokens();
  const up = loadUplink();

  if (mode !== "sign") {
    $nobyda.done({});
    return;
  }

  console.log(`\n==== 7日打卡 / mode=sign / 账号数 ${tokens.length} / 载荷 ${up ? "有" : "无"} ====`);

  if (!tokens.length) {
    $nobyda.notify("中国移动 · 7日打卡", "缺少凭证", "尚未抓到 User-Token：请在 App 打开任意一个活动页（含「7日打卡分百万」）");
    $nobyda.time();
    $nobyda.done({});
    return;
  }

  const rows = [];
  let okCount = 0, doneCount = 0, failCount = 0, needRefresh = false, signedNow = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i].token;
    const label = shortTok(tk);
    let st;
    try {
      st = await queryStatus(tk);
    } catch (e) {
      st = { ok: false, kind: "net", text: "异常: " + e };
    }

    if (!st.ok) {
      failCount++;
      if (st.kind === "token") {
        needRefresh = true;
        tokens[i].dead = true;
      }
      rows.push(`${label} 查询失败：${st.text}`);
      continue;
    }

    if (st.hasToday) {
      // 今日已签：静默跳过，不推送（避免重复提示已签到）
      doneCount++;
      if (LogDetails) console.log(`${label} 今日已签（${st.list.length}天），跳过`);
      continue;
    }

    if (!up) {
      needRefresh = true;
      failCount++;
      rows.push(`${label} 未签但无冻结载荷：请打开一次活动页抓取`);
      continue;
    }

    let ci;
    try {
      ci = await doClockIn(tk, up);
    } catch (e) {
      ci = { ok: false, kind: "net", text: "异常: " + e };
    }

    if (ci.ok && ci.kind === "success") {
      okCount++; signedNow++;
      rows.push(`${label} 打卡成功（累计${st.list.length + 1}天）`);
    } else if (ci.ok && ci.kind === "done") {
      // 业务态：本次未新增（可能已领/并发已签）
      doneCount++;
      if (LogDetails) console.log(`${label} ${ci.text}`);
    } else {
      failCount++;
      if (ci.kind === "payload" || ci.kind === "token") needRefresh = true;
      rows.push(`${label} 打卡失败：${ci.text}`);
    }
  }

  // 清理已失效 Token
  const dead = tokens.filter(t => t.dead);
  if (dead.length) saveTokens(tokens.filter(t => !t.dead));

  $nobyda.write(JSON.stringify({ at: nowStr(), ok: okCount, done: doneCount, fail: failCount, needRefresh: needRefresh }), K_LAST);

  const subtitle = signedNow > 0
    ? `打卡成功 ${signedNow} 个`
    : (failCount ? `成功0 / 已签${doneCount} / 失败${failCount}` : `全部已打卡（${doneCount}）`);

  const allSilent = signedNow === 0 && failCount === 0;
  if (allSilent && !SevenDayNotifyAlready) {
    console.log(`[静默跳过] 7日打卡：${doneCount} 个号今日已签，未产生新打卡，不推送通知`);
  } else {
    let msg = rows.join("\n");
    if (needRefresh) msg += "\n提示：请在 App 打开任意活动页刷新凭证（令牌仅 30 分钟有效）";
    $nobyda.notify("中国移动 · 7日打卡分百万", subtitle, msg || "无明细");
  }

  $nobyda.time();
  $nobyda.done({});
}

/********************* 适配层 *********************/
function nobyda() {
  const start = Date.now();
  const isRequest = typeof $request != "undefined";
  const isSurge = typeof $httpClient != "undefined";
  const isQuanX = typeof $task != "undefined";
  const isLoon = typeof $loon != "undefined";
  const isJSBox = typeof $app != "undefined" && typeof $http != "undefined";
  const isNode = typeof require == "function" && !isJSBox;
  const NodeSet = "CookieSet.json";
  const node = (() => {
    if (!isNode) return null;
    return { request: require("request"), fs: require("fs"), path: require("path") };
  })();

  const notify = (title, subtitle, message, rawopts) => {
    console.log(`${title}\n${subtitle}\n${message}`);
    if (isQuanX) $notify(title, subtitle, message, rawopts);
    if (isSurge) $notification.post(title, subtitle, message, rawopts);
    if (isLoon) $notification.post(title, subtitle, message, rawopts);
    if (isNode) {
      try {
        const p = node.path.join(__dirname, "sendNotify.js");
        if (node.fs.existsSync(p)) require(p).sendNotify(title + "\n" + subtitle, message);
      } catch (e) {}
    }
  };

  const write = (value, key) => {
    if (isQuanX) return $prefs.setValueForKey(value, key);
    if (isSurge || isLoon) return $persistentStore.write(value, key);
    if (isNode) {
      try {
        if (!node.fs.existsSync(NodeSet)) node.fs.writeFileSync(NodeSet, JSON.stringify({}));
        const data = JSON.parse(node.fs.readFileSync(NodeSet));
        if (value === "") delete data[key]; else data[key] = value;
        node.fs.writeFileSync(NodeSet, JSON.stringify(data, null, 2));
        return true;
      } catch (e) { return false; }
    }
  };

  const read = (key) => {
    if (isQuanX) return $prefs.valueForKey(key);
    if (isSurge || isLoon) return $persistentStore.read(key);
    if (isNode) {
      try {
        if (!node.fs.existsSync(NodeSet)) return "";
        const data = JSON.parse(node.fs.readFileSync(NodeSet));
        return data[key] || "";
      } catch (e) { return ""; }
    }
  };

  const adapterStatus = (response) => {
    if (response) {
      if (response.status) response.statusCode = response.status;
      else if (response.statusCode) response.status = response.statusCode;
    }
    return response;
  };

  const get = (options, callback) => {
    if (isQuanX) {
      if (typeof options === "string") options = { url: options };
      options.method = "GET";
      $task.fetch(options).then(r => callback(null, adapterStatus(r), r.body), e => callback(e.error, null, null));
    }
    if (isSurge || isLoon) $httpClient.get(options, (e, r, b) => callback(e, adapterStatus(r), b));
    if (isNode) node.request(options, (e, r, b) => callback(e, adapterStatus(r), b));
  };

  const post = (options, callback) => {
    if (isQuanX) {
      if (typeof options === "string") options = { url: options };
      options.method = "POST";
      $task.fetch(options).then(r => callback(null, adapterStatus(r), r.body), e => callback(e.error, null, null));
    }
    if (isSurge || isLoon) $httpClient.post(options, (e, r, b) => callback(e, adapterStatus(r), b));
    if (isNode) node.request.post(options, (e, r, b) => callback(e, adapterStatus(r), b));
  };

  const time = () => console.log("\n耗时: " + ((Date.now() - start) / 1000).toFixed(2) + " 秒");
  const done = (value = {}) => {
    if (isQuanX) return $done(value);
    if (isSurge || isLoon) return isRequest ? $done(value) : $done();
  };

  return { isRequest, isSurge, isQuanX, isLoon, isNode, notify, write, read, get, post, time, done };
}

/********************* 入口（必须置于文件末尾） *********************/
(async () => {
  try {
    if ($nobyda.isRequest) onRewrite();
    else await main();
  } catch (e) {
    console.log("[7日打卡] 异常: " + e);
    if (!($nobyda && $nobyda.isRequest)) $nobyda.notify("中国移动 · 7日打卡", "执行异常", String(e));
    $nobyda.done({});
  }
})();
