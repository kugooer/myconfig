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
 *   ⇒ 结论：dev.coc 活动只能「开页驱动」。
 *
 * 加密链路（逆向实测结论）:
 *   - 加密由 WASM 模块 Wheel 完成（roto 返回 [coc-aurora, cocEnContent]），
 *     无法在 QX JavaScriptCore 内重算 → 采用「冻结载荷重放」(路线 B)。
 *   - coc-aurora 是 RSA 加密的 AES 密钥，cocEnContent 是该密钥下的 AES-GCM 密文；
 *     改坏任一者服务端分别报 "RSA解密AES密钥失败" / "AES-GCM解密失败: Tag mismatch"。
 *   - ⚠️ 2026-09-21 实测修正「载荷设备级可跨账号共用」的早期判断：
 *     换任意账号的 Token 重放，服务端**都能正常解密**（不会报 300），
 *     但业务层统一返回 code 10 —— 载荷是**一次性**的（或与生成它的那次打卡绑定），
 *     被页面消费过一次后即不可再用。
 *     2026-09-21 早晨 4 个未签账号在各自 7 日页打开前注入，全部 code 10；
 *     最终 5 个号全部由用户手工完成 ⇒ 「1 份载荷代打 N 个号」不成立。
 *   ⇒ 因此能完成打卡的只有「打开 7 日页由页面自己打卡」这一个动作；
 *     本脚本的价值收窄为：抓凭证（诊断）+ 定时「漏签检查」（见 main）。
 *
 * 鉴权: Cookie: User-Token=000_<32hex>（缺失/过期返回 code 40 无权限）
 *
 * 用法:
 *   1) 打卡本体：打开「7日打卡分百万」页 → 页面加载后约 1 秒自动打卡（无需点按钮）。
 *      重写层只顺带抓 User-Token / 冻结载荷做诊断，不参与打卡本身。
 *   2) 漏签检查（定时任务）：在你每天开完 App 之后跑一次，逐个有效 Token 查状态，
 *      发现「今日未签」才通知提醒；全部已签或凭证过期一律静默。
 *      注意：Token 仅 30 分钟有效，任务时间必须落在你开完 App 后的 30 分钟窗口内。
 *
 * $argument 支持: mode=capture|sign & DeleteCookie=true
 ******************************************/

var SevenDayEnable = true;          // 总开关
var SevenDayMaxTokens = 20;         // 最多保留的账号 Token 数

// —— 注入式代打卡（默认关闭，2026-09-21 实测不可行）——
// 载荷是一次性的：页面真实打卡时被消费，之后复用一律返回 code 10（见头部说明）。
// 保留开关仅为将来若发现可复用场景再试；日常无需开启。
var SevenDayInjectOnOtherPage = false;  // 在「非 7 日页」的活动页上尝试代打
var SevenDayInjectOnOwnPage = false;    // 在 7 日页本身注入（页面自己会签，开启会抢跑）
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
  "10": { ok: true, kind: "done", text: "领取失败（业务态：今日已领取，或冻结载荷已被占用/不可复用——需结合查状态区分）" },
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

  if (!SevenDayEnable) { $nobyda.done({}); return; }
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
      // 此处必为「已确认今日未签」后打卡 ⇒ code 10 = 载荷被占用/不可复用，
      // 不是「今日已领」（2026-09-21 实测：复用任何已消费载荷统一返回 10）。
      // 静默处理：代打本就走不通，是否漏签交给定时任务的漏签检查汇总提醒，
      // 避免每开一页推一条。
      console.log(`[7日打卡] ${label} 载荷不可复用（code 10，非今日已领），跳过代打`);
    } else {
      console.log(`[7日打卡] ${label} 注入打卡失败：${ci.text}`);
      $nobyda.notify("中国移动 · 7日打卡分百万", "打卡失败", `${label} ${ci.text}`);
    }
  } catch (e) {
    console.log("[7日打卡] 注入异常: " + e);
  }
}

/********************* 漏签检查（定时任务 / 手动） *********************/
/**
 * 定位（2026-09-21 修订）：打卡本体只能由「打开 7 日页」完成（载荷一次性、
 * 令牌 30 分钟），脚本无法代打。本入口因此收窄为「漏签检查」：
 *   - 逐个**仍有效**的 Token 查状态；发现今日未签才通知提醒
 *   - code 40（凭证过期）不算漏签，清理即可，不触发通知
 *   - 全部已签 / 全部过期 → 静默
 * ⚠️ Token 仅 30 分钟有效：任务时间必须落在你每天开完 App 后的 30 分钟窗口内，
 *    否则所有 Token 已过期，检查无从谈起（此时静默）。
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

  const mode = String(args.mode || "sign");
  const tokens = loadTokens();
  const up = loadUplink();

  if (mode !== "sign") {
    $nobyda.done({});
    return;
  }

  console.log(`\n==== 7日打卡 / 漏签检查 / 账号数 ${tokens.length} / 载荷 ${up ? "有" : "无"} ====`);

  if (!tokens.length) {
    // 失效 Token 会在每次运行末尾清理；列表为空 = 当前没有可用凭证，属预期态，
    // 静默即可（打开任意 dev.coc 活动页即自动抓取新 Token）。
    console.log("[7日打卡] 无可用 Token：打开任意 dev.coc 活动页即自动抓取（过期的已自动清理）");
    $nobyda.time();
    $nobyda.done({});
    return;
  }

  // 复核语义（2026-09-21 修订）：
  //   - code 40（Token 过期）不算漏签：只标记清理，不进通知（隔夜必然全过期）
  //   - 只有「Token 仍有效且该号今日未签」才需要提醒；打卡成功也提醒
  const misses = [];
  let doneCount = 0, deadTokenCount = 0, signedNow = 0;

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
      if (st.kind === "token") {
        deadTokenCount++;
        tokens[i].dead = true;   // 标记，循环结束后出库
      } else {
        misses.push(`${label} 查询失败：${st.text}`);
      }
      continue;
    }

    if (st.hasToday) {
      doneCount++;
      if (LogDetails) console.log(`${label} 今日已签（${st.list.length}天）`);
      continue;
    }

    // —— 该号今日确实未签 ——
    if (!up) {
      misses.push(`${label} 今日未打卡（无冻结载荷，无法代打）：请打开一次「7日打卡分百万」页`);
      continue;
    }

    let ci;
    try {
      ci = await doClockIn(tk, up);
    } catch (e) {
      ci = { ok: false, kind: "net", text: "异常: " + e };
    }

    if (ci.ok && ci.kind === "success") {
      signedNow++;
      misses.push(`${label} 打卡成功（累计${st.list.length + 1}天）`);
    } else if (ci.ok && ci.kind === "done") {
      // 已确认未签仍返回 code 10 ⇒ 载荷被占用/不可复用（2026-09-21 实测：
      // 复用任何已消费载荷统一返回 10），不是「今日已领」
      misses.push(`${label} 今日未打卡（载荷不可复用，无法代打）：请打开一次「7日打卡分百万」页`);
    } else {
      misses.push(`${label} 打卡失败：${ci.text}`);
    }
  }

  // User-Token 只有 30 分钟寿命，失效 Token 永远不会再可用 → 出库，
  // 避免列表越积越多、下次运行多打 N 次注定失败的查询。
  const alive = tokens.filter(t => !t.dead);
  if (alive.length !== tokens.length) saveTokens(alive);

  $nobyda.write(JSON.stringify({
    at: nowStr(), signed: signedNow, done: doneCount,
    dead: deadTokenCount, miss: misses.length, hasUplink: !!up
  }), K_LAST);

  // 只在「确有漏签 / 补签成功 / 其它异常」时通知；全部已签或凭证过期 → 静默
  if (misses.length) {
    const subtitle = signedNow > 0 ? `补签成功 ${signedNow} 个` : `漏签 ${misses.length} 个`;
    let msg = misses.join("\n");
    if (!up) msg += "\n提示：冻结载荷只在页面真实打卡时产生，请先开一次 7 日页";
    $nobyda.notify("中国移动 · 7日打卡分百万", subtitle, msg);
  } else {
    console.log(`[静默跳过] 7日打卡复核：${doneCount} 个号已签，${deadTokenCount} 个过期凭证已清理，无漏签`);
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
