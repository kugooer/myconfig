/*************************

  微信读书(WeRead) 每日签到脚本

  更新时间: 2026-08-18 (capture-v1.1)
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  v1.1: 奖励类型兼容 —— 书币(money) / 天数(days/day/duration/expireDays/validDays) / 礼品(gift) /
        带 name/desc 的奖励均正常展示；成功判定放宽，不会因类型不同误报失败

  流量结论（抓包 2026-08-17-150112）:
  - 活动查询: GET https://weread.qq.com/membership-promotions/api/membershipPromotions?pf=ios
    → 响应含今日期号 issue（服务端动态下发）
  - 签到领取: POST https://weread.qq.com/membership-promotions/api/receive?platform=ios
    body: {"issue":"20260817"} → 成功返回 money:200 (=2 书币) / type / name / receiveTime
  - 余额查询: POST https://weread.qq.com/membership-promotions/api/balance?pf=ios  body: {}
  - 认证: 请求头 vid + skey（skey 短时效，实测约 1 小时内失效 → 401 errCode=-2012）
  - 自动续期: POST https://i.weread.qq.com/login 原样重放（body 含 refreshToken/signature 等）
    → 即使返回 errcode=-2013（微信授权过期），服务端仍下发新 accessToken（= 新 skey）
    → signature 绑定 timestamp 无法重算，只能整套重放；refreshToken 不过期即可无限续期

  用法:
  1) 挂 rewrite，登录微信读书 → 打开「会员日」页面（触发 membership-promotions 请求）
  2) 通知「凭证已保存」后，手动/定时跑 task
  3) skey 失效时脚本自动重放 login 续期并写回，无需重抓
  4) 多账号: 多设备或切号进会员日页面，脚本按 vid 去重累计

*************************/

var LogDetails = false;
var DeleteCookie = false;
var Notify = true;
var out = 0;

var $nobyda = nobyda();
var DefaultUA = "WeRead/10.2.1 (iPhone; iOS 26.4.1; Scale/3.00)";
var PREFIX = "WeRead";
var HOST = "weread.qq.com";
var CHANNEL_ID = "AppStore";
var BASEVER = "10.2.1.87";

var API_MEMBERSHIP = "https://weread.qq.com/membership-promotions/api/membershipPromotions?pf=ios";
var API_RECEIVE = "https://weread.qq.com/membership-promotions/api/receive?platform=ios";
var API_BALANCE = "https://weread.qq.com/membership-promotions/api/balance?pf=ios";
var API_LOGIN = "https://i.weread.qq.com/login";

// Node / 手动: 逗号或换行分隔；或 JSON 数组 [{"vid":"...","skey":"...","loginBody":"{...}","loginCT":"..."}]
var OtherKey = ``;

var merge = {};

(async () => {
  try {
    if (DeleteCookie) {
      [PREFIX + "_Cookie", PREFIX + "_Cookies", PREFIX + "_LoginBody", PREFIX + "_CaptureDiag"].forEach((s) => {
        $nobyda.write("", s);
      });
      throw new Error("已清除微信读书签到凭证，请重新打开 App 会员日页面抓取 ‼️");
    }

    if ($nobyda.isRequest) {
      // 抓包路径：只更新凭证，不打印「签到用时」（由 GetCookie 内 $done）
      GetCookie();
      return;
    }

    const cookies = ReadCookies();
    if (!cookies.length) throw new Error(buildNoCookieTip());

    for (let i = 0; i < cookies.length; i++) {
      await all(cookies[i], i + 1);
    }
  } catch (e) {
    if (!$nobyda.isRequest) {
      $nobyda.notify("微信读书签到", "", String(e.message || e));
      console.log("\n" + (e.stack || e));
    } else {
      console.log("[WeRead] capture err " + (e.message || e));
    }
  } finally {
    // request 模式下 GetCookie 已 $done；切勿再 time/done，否则日志刷屏
    if (!$nobyda.isRequest) {
      $nobyda.time();
      $nobyda.done();
    }
  }
})();

function isValidCookie(item) {
  if (!item || !item.vid || !item.skey) return false;
  return /^[A-Za-z0-9\-_]{4,64}$/.test(String(item.vid)) && /^[A-Za-z0-9\-_]{4,128}$/.test(String(item.skey));
}

function ReadCookies() {
  let list = [];
  try {
    list = JSON.parse($nobyda.read(PREFIX + "_Cookies") || "[]");
    if (!Array.isArray(list)) list = [];
  } catch (e) {
    list = [];
  }
  const one = $nobyda.read(PREFIX + "_Cookie");
  if (one) {
    try {
      const o = JSON.parse(one);
      if (o) list.unshift(o);
    } catch (e) {
      list.unshift({ vid: one });
    }
  }
  if (OtherKey && String(OtherKey).trim()) {
    parseOtherKey(String(OtherKey).trim()).forEach((x) => list.push(x));
  }
  const seen = {};
  return list
    .map(normalizeCookie)
    .filter((x) => x && isValidCookie(x))
    .filter((item) => {
      const k = String(item.vid).toLowerCase();
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
}

function parseOtherKey(text) {
  if (text[0] === "[" || text[0] === "{") {
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j)) return j;
      return [j];
    } catch (e) {}
  }
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((vid) => ({ vid }));
}

function normalizeCookie(input) {
  if (!input) return null;
  if (typeof input === "object") {
    const vid = String(input.vid || input.request || "").trim();
    const skey = String(input.skey || "").trim();
    if (!vid || !skey) return null;
    return {
      vid,
      skey,
      name: input.name || shortVid(vid),
      update: input.update || "",
      lastUrl: input.lastUrl || "",
      loginBody: input.loginBody || "",
      loginCT: input.loginCT || ""
    };
  }
  const text = String(input).trim();
  if (!text) return null;
  if (text[0] === "{" || text[0] === "[") {
    try {
      return normalizeCookie(JSON.parse(text));
    } catch (e) {}
  }
  return { vid: text, skey: text, name: shortVid(text) };
}

function shortVid(v) {
  const s = String(v || "");
  return s.slice(0, 6) + "…" + s.slice(-4);
}

async function all(cookieItem, index) {
  merge = {};
  await doSignIn(cookieItem);
  await notifyDone(index, cookieItem);
}

function doSignIn(cookieItem) {
  merge.Sign = {};
  return (async () => {
    try {
      const item = Object.assign({}, cookieItem);
      // 续期所需的 login body 若 item 缺失，从全局按 vid 取（抓包时 login 与 membership 未必同时命中）
      const le = findLoginEntry(item.vid);
      if (le) {
        if (!item.loginBody) item.loginBody = le.body;
        if (!item.loginCT) item.loginCT = le.contentType || "application/x-www-form-urlencoded";
      }

      // 1) 查询今日活动，动态获取 issue
      let mRaw = await httpGet(API_MEMBERSHIP, item);
      let mObj = safeJSON(mRaw);
      if (isSessionExpired(mObj)) {
        const renewed = await tryRenew(item);
        if (renewed) {
          mRaw = await httpGet(API_MEMBERSHIP, item);
          mObj = safeJSON(mRaw);
        }
      }
      const issue = mObj && mObj.issue ? String(mObj.issue) : "";
      if (!issue) {
        const hint = describeResp(mObj, mRaw);
        if (/登录|超时|过期|失效/i.test(hint)) {
          merge.Sign.notify = "微信读书签到: " + hint + " ‼️\n请重新打开微信读书 App「会员日」页面刷新凭证";
        } else {
          merge.Sign.notify = "微信读书签到: 查询活动失败 " + hint + " ‼️";
        }
        merge.Sign.fail = 1;
        return;
      }

      // 2) 领取今日奖励（签到核心）
      let rRaw = await httpPost(API_RECEIVE, JSON.stringify({ issue: issue }), item);
      let rObj = safeJSON(rRaw);
      if (isSessionExpired(rObj)) {
        const renewed = await tryRenew(item);
        if (renewed) {
          rRaw = await httpPost(API_RECEIVE, JSON.stringify({ issue: issue }), item);
          rObj = safeJSON(rRaw);
        }
      }
      // 成功判定兼容多种奖励形态：书币(money) / 天数(days/day/duration/expireDays/validDays) / 礼品(name/receiveTime)
      if (rObj && (rObj.money != null || rObj.receiveTime || rObj.name || rObj.days != null || rObj.day != null || rObj.duration != null || rObj.expireDays != null || rObj.validDays != null)) {
        const reward = fmtReward(rObj);
        merge.Sign.notify = "微信读书签到: 成功 ✅\n今日奖励: " + (reward || "（已到账）");
        merge.Sign.success = 1;
      } else if (rObj && /已领取|已领过|重复领取|已签到|already|receiveTime/i.test(String(rObj.errMsg || rObj.errmsg || rObj.msg || ""))) {
        merge.Sign.notify = "微信读书签到: 今日已领取 ✅";
        merge.Sign.success = 1;
      } else {
        const hint = describeResp(rObj, rRaw);
        merge.Sign.notify = "微信读书签到: 领取失败 " + hint + " ‼️";
        merge.Sign.fail = 1;
        return;
      }

      // 3) 余额（尽力而为）
      try {
        const bRaw = await httpPost(API_BALANCE, "{}", item);
        const bObj = safeJSON(bRaw);
        if (bObj && bObj.balance != null) {
          merge.Sign.notify +=
            "\n当前书币: " + bObj.balance + (bObj.giftBalance != null ? "（赠送 " + bObj.giftBalance + "）" : "");
        }
      } catch (e) {}
    } catch (eor) {
      merge.Sign.notify = "微信读书签到: 异常 " + (eor.message || eor) + " ‼️";
      merge.Sign.fail = 1;
      console.log(eor.stack || eor);
    }
  })();
}

// 重放 /login 续期 skey：即便 errcode=-2013（微信授权过期），服务端仍下发新 accessToken（= 新 skey）
function tryRenew(item) {
  return new Promise((resolve) => {
    if (!item.loginBody) {
      console.log("[WeRead renew] no loginBody, skip auto-renew");
      resolve(false);
      return;
    }
    const headers = {
      "Content-Type": item.loginCT || "application/x-www-form-urlencoded",
      vid: item.vid,
      v: BASEVER,
      Accept: "*/*",
      "User-Agent": DefaultUA,
      "Accept-Language": "zh-Hans-CN;q=1, en-CN;q=0.9, zh-Hant-CN;q=0.8",
      "Accept-Encoding": "gzip"
    };
    httpPostRaw(API_LOGIN, item.loginBody, headers)
      .then((raw) => {
        const obj = safeJSON(raw);
        const newSkey = obj && obj.accessToken ? String(obj.accessToken) : "";
        if (newSkey && /^[A-Za-z0-9\-_]{4,128}$/.test(newSkey)) {
          item.skey = newSkey;
          persistSkey(item);
          console.log("[WeRead renew] skey refreshed -> " + shortVid(newSkey));
          resolve(true);
        } else {
          console.log("[WeRead renew] failed: " + String(raw).slice(0, 200));
          resolve(false);
        }
      })
      .catch((e) => {
        console.log("[WeRead renew] " + e);
        resolve(false);
      });
  });
}

function isSessionExpired(obj) {
  if (obj && typeof obj === "object") {
    const code = obj.errCode != null ? obj.errCode : obj.errcode;
    if (code === -2012 || code === -2013) return true; // 登录超时 / 微信授权过期
  }
  return false;
}

function describeResp(obj, raw) {
  if (obj && typeof obj === "object") {
    const err = obj.errMsg || obj.errmsg || obj.msg;
    const code = obj.errCode != null ? obj.errCode : obj.errcode;
    if (err || code != null) return "errCode=" + code + (err ? " " + err : "");
    const s = JSON.stringify(obj);
    return s ? s.slice(0, 200) : "";
  }
  return String(raw || "").slice(0, 200);
}

function fmtReward(obj) {
  if (!obj || typeof obj !== "object") return null;
  const name = String(obj.name || "").trim();
  const type = String(obj.type || "");
  const money = obj.money;
  // 书币（分 -> 枚，去尾零）
  if (type === "money" && money != null) {
    const coins = Number(money) / 100;
    const coinsStr = Number.isInteger(coins) ? String(coins) : String(Math.round(coins * 100) / 100);
    return (name ? name + " " : "书币 ") + coinsStr + " 枚";
  }
  // 礼品盲盒
  if (type === "gift") return name || "实体书盲盒";
  // 天数类奖励（会员天数/体验卡等，字段名以抓包实测为准，兜底常见命名）
  const dayKey = ["days", "day", "duration", "expireDays", "validDays", "memberDays", "vipDays"].find(
    (k) => obj[k] != null
  );
  if (dayKey) {
    const n = Number(obj[dayKey]);
    if (isFinite(n) && n > 0) return (name ? name + " " : "会员天数 ") + n + " 天";
  }
  if (name) return name;
  // 其它描述字段兜底
  const desc = String(obj.desc || obj.title || obj.rewardName || obj.rewardDesc || "").trim();
  if (desc) return desc;
  return null;
}

function notifyDone(index, cookieItem) {
  return new Promise((resolve) => {
    const title = "微信读书签到";
    const sub = (cookieItem && cookieItem.name) || "#" + index;
    const msg = (merge.Sign && merge.Sign.notify) || "无明细";
    if (Notify) $nobyda.notify(title, sub, msg);
    console.log("\n" + title + "\n" + sub + "\n" + msg);
    resolve();
  });
}

function buildNoCookieTip() {
  return (
    "未获取到微信读书凭证\n" +
    "1) 更新并启用 rewrite: WeRead_DailyBonus.conf\n" +
    "2) 信任 MitM 证书（hostname 含 weread.qq.com / i.weread.qq.com）\n" +
    "3) 打开微信读书 → 「会员日」页面\n" +
    "4) 看到「凭证已保存」后再跑定时任务"
  );
}

function GetCookie() {
  try {
    const req = typeof $request !== "undefined" ? $request : null;
    if (!req || !req.url) {
      $nobyda.done({});
      return;
    }
    const url = String(req.url || "");
    if (!/weread\.qq\.com/i.test(url)) {
      $nobyda.done({});
      return;
    }
    if (/^OPTIONS/i.test(String(req.method || ""))) {
      $nobyda.done({});
      return;
    }
    const headers = req.headers || {};
    const vid = String(headers.vid || headers.Vid || "").trim();
    const skey = String(headers.skey || headers.Skey || "").trim();
    const hostRaw = String(headers.Host || headers.host || "").replace(/:\d+$/, "");

    // 登录续期接口：抓原始 body 供自动续期重放（signature 绑定 timestamp，只能整套重放）
    if (/^https?:\/\/i\.weread\.qq\.com\/login/i.test(url) && (req.body != null && req.body !== "")) {
      const loginCT = String(headers["Content-Type"] || headers["content-type"] || "application/x-www-form-urlencoded");
      const entry = { vid, body: String(req.body), contentType: loginCT, update: new Date().toISOString() };
      $nobyda.write(JSON.stringify(entry), PREFIX + "_LoginBody");
      console.log("[WeRead capture] login body saved vid=" + (vid || "-") + " len=" + String(req.body).length);
      $nobyda.done({});
      return;
    }

    // 会员日活动：抓 vid/skey（route A 签名路径）
    if (!/weread\.qq\.com\/membership-promotions\//i.test(url)) {
      $nobyda.done({});
      return;
    }
    if (!vid || !isValidCookie({ vid: vid, skey: skey })) {
      $nobyda.done({});
      return;
    }

    const diag =
      new Date().toISOString() +
      " | " +
      String(req.method || "") +
      " | host=" +
      hostRaw +
      " | vid=" +
      vid +
      " | url=" +
      url.slice(0, 160);
    if (LogDetails) console.log("[WeRead capture] " + diag);
    appendDiag(diag);

    const item = {
      vid,
      skey,
      name: shortVid(vid),
      update: new Date().toISOString(),
      lastUrl: url.slice(0, 200)
    };

    const saved = saveCookie(item);
    if (saved === "new") {
      $nobyda.notify("微信读书签到", item.name, "凭证新增 ✅\nvid=" + shortVid(vid));
      console.log("[WeRead] cookie new " + item.name);
    } else if (saved === "update") {
      if (LogDetails) console.log("[WeRead] cookie updated " + item.name);
    }
    $nobyda.done({});
  } catch (e) {
    console.log("[GetCookie] " + e);
    $nobyda.done({});
  }
}

function saveCookie(item) {
  let list = [];
  try {
    list = JSON.parse($nobyda.read(PREFIX + "_Cookies") || "[]");
    if (!Array.isArray(list)) list = [];
  } catch (e) {
    list = [];
  }
  const key = String(item.vid).toLowerCase();
  let found = false;
  let changed = false;
  list = list.map((x) => {
    if (x && String(x.vid || "").toLowerCase() === key) {
      found = true;
      const merged = Object.assign({}, x, item);
      // 保留用户自定义 name（非短 vid 形态）
      if (x.name && x.name.indexOf("…") < 0) merged.name = x.name;
      if (JSON.stringify(merged) !== JSON.stringify(x)) changed = true;
      return merged;
    }
    return x;
  });
  if (!found) {
    list.unshift(item);
    changed = true;
  }
  list = list.filter((x) => isValidCookie(x)).slice(0, 10);
  $nobyda.write(JSON.stringify(list), PREFIX + "_Cookies");
  $nobyda.write(JSON.stringify(list[0] || item), PREFIX + "_Cookie");
  if (!found) return "new";
  return changed ? "update" : "same";
}

// 续期成功后写回持久化，下次运行直接用新 skey
function persistSkey(item) {
  try {
    let list = [];
    try {
      list = JSON.parse($nobyda.read(PREFIX + "_Cookies") || "[]");
    } catch (e) {
      list = [];
    }
    if (!Array.isArray(list)) list = [];
    const key = String(item.vid).toLowerCase();
    list = list.map((x) => {
      if (x && String(x.vid || "").toLowerCase() === key) {
        return Object.assign({}, x, { skey: item.skey, update: new Date().toISOString() });
      }
      return x;
    });
    $nobyda.write(JSON.stringify(list), PREFIX + "_Cookies");
    if (list[0]) $nobyda.write(JSON.stringify(list[0]), PREFIX + "_Cookie");
  } catch (e) {}
}

function findLoginEntry(vid) {
  try {
    const entry = JSON.parse($nobyda.read(PREFIX + "_LoginBody") || "null");
    if (entry && entry.body) {
      if (!entry.vid || String(entry.vid).toLowerCase() === String(vid).toLowerCase()) return entry;
    }
  } catch (e) {}
  return null;
}

function appendDiag(line) {
  try {
    const prev = $nobyda.read(PREFIX + "_CaptureDiag") || "";
    const next = (line + "\n" + prev).split("\n").slice(0, 30).join("\n");
    $nobyda.write(next, PREFIX + "_CaptureDiag");
  } catch (e) {}
}

function weReadHeaders(item, isPost) {
  const h = {
    Accept: "*/*",
    "Accept-Language": "zh-Hans-CN;q=1, en-CN;q=0.9, zh-Hant-CN;q=0.8",
    "Accept-Encoding": "gzip",
    channelId: CHANNEL_ID,
    basever: BASEVER,
    v: BASEVER,
    vid: item.vid,
    skey: item.skey,
    "User-Agent": DefaultUA,
    Connection: "keep-alive"
  };
  if (isPost) h["Content-Type"] = "application/json";
  return h;
}

function httpGet(url, item) {
  return new Promise((resolve, reject) => {
    const options = { url, headers: weReadHeaders(item, false) };
    if (out) options.timeout = out;
    $nobyda.get(options, function (error, response, data) {
      if (error) reject(new Error(error));
      else resolve(data);
    });
  });
}

function httpPost(url, body, item) {
  return new Promise((resolve, reject) => {
    const options = { url, headers: weReadHeaders(item, true), body: typeof body === "string" ? body : JSON.stringify(body || {}) };
    if (out) options.timeout = out;
    $nobyda.post(options, function (error, response, data) {
      if (error) reject(new Error(error));
      else resolve(data);
    });
  });
}

function httpPostRaw(url, body, headers) {
  return new Promise((resolve, reject) => {
    const options = { url, headers, body: typeof body === "string" ? body : JSON.stringify(body || {}) };
    if (out) options.timeout = out;
    $nobyda.post(options, function (error, response, data) {
      if (error) reject(new Error(error));
      else resolve(data);
    });
  });
}

function safeJSON(text) {
  try {
    if (text == null) return null;
    if (typeof text === "object") return text;
    let s = String(text).trim();
    // 兼容 chunked 抓包残留
    if (s[0] !== "{" && s[0] !== "[") {
      const i = s.indexOf("{");
      const j = s.lastIndexOf("}");
      if (i >= 0 && j > i) s = s.slice(i, j + 1);
    }
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

/* ========================= nobyda 适配层 ========================= */

function nobyda() {
  const start = Date.now();
  const isRequest = typeof $request != "undefined";
  const isSurge = typeof $httpClient != "undefined";
  const isQuanX = typeof $task != "undefined";
  const isLoon = typeof $loon != "undefined";
  const isJSBox = typeof $app != "undefined" && typeof $http != "undefined";
  const isNode = typeof require == "function" && !isJSBox;
  const node = (() => {
    if (isNode) {
      const request = require("request");
      return { request };
    } else {
      return null;
    }
  })();
  const notify = (title, subtitle, message) => {
    if (isQuanX) $notify(title, subtitle, message);
    if (isSurge) $notification.post(title, subtitle, message);
    if (isNode) console.log(JSON.stringify({ title, subtitle, message }));
    if (isJSBox) $push.schedule({ title: title, body: subtitle ? subtitle + "\n" + message : message });
  };
  const write = (value, key) => {
    if (isQuanX) return $prefs.setValueForKey(value, key);
    if (isSurge) return $persistentStore.write(value, key);
    if (isNode) {
      try {
        const fs = require("fs");
        const path = "weread_cookie.json";
        let obj = {};
        if (fs.existsSync(path)) obj = JSON.parse(fs.readFileSync(path) || "{}");
        if (value === "") delete obj[key];
        else obj[key] = value;
        fs.writeFileSync(path, JSON.stringify(obj));
        return true;
      } catch (e) {
        return false;
      }
    }
  };
  const read = (key) => {
    if (isQuanX) return $prefs.valueForKey(key);
    if (isSurge) return $persistentStore.read(key);
    if (isNode) {
      try {
        const fs = require("fs");
        const path = "weread_cookie.json";
        if (!fs.existsSync(path)) return null;
        const obj = JSON.parse(fs.readFileSync(path) || "{}");
        return obj[key];
      } catch (e) {
        return null;
      }
    }
  };
  const adapterStatus = (response) => {
    if (response) {
      if (response.status) {
        response["statusCode"] = response.status;
      } else if (response.statusCode) {
        response["status"] = response.statusCode;
      }
    }
    return response;
  };
  const get = (options, callback) => {
    if (isQuanX) {
      if (typeof options == "string") options = { url: options };
      options["method"] = "GET";
      $task.fetch(options).then(
        (response) => {
          callback(null, adapterStatus(response), response.body);
        },
        (reason) => callback(reason.error, null, null)
      );
    }
    if (isSurge)
      $httpClient.get(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    if (isNode) {
      node.request(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    }
  };
  const post = (options, callback) => {
    if (isQuanX) {
      if (typeof options == "string") options = { url: options };
      options["method"] = "POST";
      $task.fetch(options).then(
        (response) => {
          callback(null, adapterStatus(response), response.body);
        },
        (reason) => callback(reason.error, null, null)
      );
    }
    if (isSurge) {
      $httpClient.post(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    }
    if (isNode) {
      node.request.post(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    }
  };
  const AnError = (name, keyname, er, resp, body) => {
    if (typeof merge !== "undefined" && merge[keyname]) {
      if (!merge[keyname].error) merge[keyname].error = 0;
      merge[keyname].error++;
      merge[keyname].notify = name + ": 异常, 已尝试完整日志 ‼️";
    }
    return console.log("\n‼️" + name + " - 异常错误:\n" + er + (resp ? "\n响应码: " + resp.status : "") + (body ? "\n响应体:\n" + body : ""));
  };
  const time = () => {
    const end = ((Date.now() - start) / 1000).toFixed(2);
    return console.log("\n签到用时: " + end + " 秒");
  };
  const done = (value = {}) => {
    if (isQuanX) return isRequest ? $done(value) : $done();
    if (isSurge) return isRequest ? $done(value) : $done();
  };
  return { AnError, isRequest, isJSBox, isSurge, isQuanX, isLoon, isNode, notify, write, read, get, post, time, done };
}
