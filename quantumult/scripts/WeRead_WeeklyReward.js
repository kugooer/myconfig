/*************************

  微信读书(WeRead) 我的阅读奖励领取脚本

  更新时间: 2026-08-25 (capture-v1.0)
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  capture-v1.0: 初版。复用 WeRead_Cookies / WeRead_LoginBody 凭证(由
                WeRead_DailyBonus.js 统一抓取，capture-v1.3 起覆盖
                flip-card-game/api 路径；本端点用 header vid/skey，与
                每日签到同源，无需额外 conf)。
                每周三、周五定时领取「我的阅读」时长/天数奖励。

  流量结论（抓包 2026-08-25-102006）:
  - 端点: POST https://i.weread.qq.com/weekly/exchange
  - 认证: header vid + skey（与每日签到同源，复用 WeRead_Cookies）
  - 查询(只读): body { awardLevelId:0, unread:0, isExchangeAward:0,
      pf, isVisitReadGoal:1, awardChoiceType:0 }
    → 响应含 readtimeAwards / readdayAwards / readgoalAwards 数组
    → awardStatus: 0=未达 1=可领(领取) 2=已领取
    → 每项 awardChoices: choiceType=1 体验卡(awardNum=天),
                          choiceType=2 书币(awardNum=枚)
  - 领取: body { unread:1, awardChoiceType:<1|2>, pf,
      awardLevelId:<level>, isExchangeAward:1 }
    → 响应中该 awardLevelId 的 awardStatus 变 2(已领取) 即成功
  - 会员卡兑换(memberCardExchange)为付费/用体验卡换，非免费奖励，跳过
  - 规则(用户确认): 书币 awardNum >= 2 领书币(choiceType2),
    否则领体验卡(choiceType1)

  用法:
  1) 确保已挂载 WeRead_DailyBonus.conf 且抓到过凭证(打开 App 首页即可)
  2) 挂 task/WeRead_WeeklyReward.task → 每周三、周五 08:10 自动执行
  3) 脚本只领取 awardStatus==1 的项，已领(status==2)自动跳过，幂等

*************************/

var PREFIX = "WeRead";
var HOST = "i.weread.qq.com";
var CHANNEL_ID = "AppStore";
var BASEVER = "10.2.1.87";
var DefaultUA = "WeRead/10.2.1 (iPhone; iOS 26.4.1; Scale/3.00)";

var API = "https://i.weread.qq.com/weekly/exchange";
var PF = "weread_wx-2001-iap-2001-iphone";
var COIN_THRESHOLD = 2; // 书币 awardNum >= 2 领书币，否则领体验卡
var out = 15000;        // 请求超时(ms)
var LogDetails = false; // 详细日志
var DeleteCookie = false;
var merge = {};

// 适配层初始化（放 IIFE 之前；nobyda 函数声明被 hoisted）
var $nobyda = nobyda();

/* ========================= 主流程 ========================= */

(async () => {
  try {
    if (DeleteCookie) {
      ["WeRead_Cookie", "WeRead_Cookies", "WeRead_LoginBody", "WeRead_WeeklyDiag"].forEach((s) => {
        $nobyda.write("", s);
      });
      throw new Error("已清除微信读书凭证，请重新打开微信读书 App 抓取 ‼️");
    }

    const cookies = ReadCookies();
    if (!cookies.length) {
      throw new Error(
        "未获取到微信读书凭证\n" +
        "1) 更新并启用 rewrite: WeRead_DailyBonus.conf (capture-v1.3+)\n" +
        "2) 信任 MitM 证书（hostname 含 weread.qq.com / i.weread.qq.com）\n" +
        "3) 打开微信读书 App 首页（自动抓 header 凭证）\n" +
        "4) 看到「凭证已保存」后再跑定时任务"
      );
    }

    for (let i = 0; i < cookies.length; i++) {
      await all(cookies[i], i + 1);
    }
  } catch (e) {
    if (!$nobyda.isRequest) {
      $nobyda.notify("微信读书我的阅读", "", String(e.message || e));
      console.log("\n" + (e.stack || e));
    } else {
      console.log("[WeRead weekly] err " + (e.message || e));
    }
  } finally {
    if (!$nobyda.isRequest) {
      $nobyda.time();
      $nobyda.done();
    }
  }
})();

function all(cookieItem, index) {
  merge = {};
  return (async () => {
    const item = Object.assign({}, cookieItem);
    if (item.loginBody) {
      const renewed = await tryRenew(item);
      if (renewed) console.log("[WeRead weekly] skey refreshed -> " + shortVid(item.skey));
    }
    await doReward(item, false);
    await notifyDone(index, item);
  })();
}

async function doReward(item, hasRetried) {
  merge.Weekly = {};
  try {
    // 1) 查询当前可领奖励
    const statusRaw = await httpPost(API, buildQueryBody(), item);
    const data = safeJSON(statusRaw);
    if (!data || !Array.isArray(data.readtimeAwards)) {
      // 可能为会话过期，尝试续期一次后重试
      if (!hasRetried) {
        const renewed = await tryRenew(item);
        if (renewed) {
          console.log("[WeRead weekly] status 异常，已续期，重试");
          return doReward(item, true);
        }
      }
      merge.Weekly.fail = 1;
      merge.Weekly.notify = "微信读书我的阅读: 查询奖励失败 ‼️\n请重新打开 App 抓取凭证";
      return;
    }

    // 2) 收集所有可领奖励（跨时长/天数/目标三类）
    const arrays = ["readtimeAwards", "readdayAwards", "readgoalAwards"];
    const claimable = [];
    for (const arr of arrays) {
      for (const a of data[arr] || []) {
        if (a && a.awardStatus === 1 && Array.isArray(a.awardChoices)) {
          claimable.push({ arr, award: a });
        }
      }
    }

    if (!claimable.length) {
      merge.Weekly.success = 1;
      merge.Weekly.notify = "微信读书我的阅读: 暂无可领奖励\n（已全部领取或本周阅读时长未达标）";
      return;
    }

    // 3) 逐条领取
    const results = [];
    let anyFail = false;
    for (const { arr, award } of claimable) {
      const choice = decideChoice(award);
      if (!choice) {
        results.push("• " + (award.awardLevelDesc || "奖励") + ": 无可选奖品，跳过");
        continue;
      }
      const body = {
        unread: 1,
        awardChoiceType: choice.choiceType,
        pf: PF,
        awardLevelId: award.awardLevelId,
        isExchangeAward: 1
      };
      if (LogDetails) console.log("[WeRead weekly] claim level=" + award.awardLevelId + " choice=" + choice.choiceType);
      let claimRaw;
      try {
        claimRaw = await httpPost(API, body, item);
      } catch (e) {
        anyFail = true;
        results.push("• " + (award.awardLevelDesc || "奖励") + ": 请求失败 " + e.message);
        continue;
      }
      const claimData = safeJSON(claimRaw);
      const ok = verifyClaimed(claimData, award.awardLevelId, choice.choiceType);
      if (ok) {
        results.push("• " + (award.awardLevelDesc || "奖励") + ": 领取 " + choice.label + " ✅");
      } else {
        anyFail = true;
        results.push("• " + (award.awardLevelDesc || "奖励") + ": 领取 " + choice.label + " 未确认(可能已领或条件变化)");
      }
    }

    // 4) 若有过失败且未重试过，尝试续期后整体重试一次
    if (anyFail && !hasRetried) {
      const renewed = await tryRenew(item);
      if (renewed) {
        console.log("[WeRead weekly] 部分领取失败，已续期，重试");
        return doReward(item, true);
      }
    }

    if (anyFail) {
      merge.Weekly.fail = 1;
      merge.Weekly.notify = "微信读书我的阅读: 部分完成 ⚠️\n" + results.join("\n");
    } else {
      merge.Weekly.success = 1;
      merge.Weekly.notify = "微信读书我的阅读: 领取成功 ✅\n" + results.join("\n");
    }
  } catch (e) {
    merge.Weekly.fail = 1;
    merge.Weekly.notify = "微信读书我的阅读: 失败 ‼️\n" + String(e.message || e);
    console.log("[WeRead weekly] " + e);
  }
}

// 规则: 书币 awardNum >= COIN_THRESHOLD 领书币(choiceType2)，否则领体验卡(choiceType1)
function decideChoice(award) {
  const choices = award.awardChoices || [];
  const card = choices.find((c) => c.choiceType === 1); // 体验卡
  const coin = choices.find((c) => c.choiceType === 2); // 书币
  const coinNum = coin ? Number(coin.awardNum) : 0;
  if (coin && coinNum >= COIN_THRESHOLD) {
    return { choiceType: 2, label: "书币 × " + coinNum };
  }
  if (card) {
    return { choiceType: 1, label: "体验卡 × " + (Number(card.awardNum) || 1) + " 天" };
  }
  if (coin) {
    return { choiceType: 2, label: "书币 × " + coinNum };
  }
  return null;
}

// 校验领取是否成功: 响应中该 awardLevelId 的 awardStatus 变为 2
function verifyClaimed(data, levelId, choiceType) {
  if (!data || typeof data !== "object") return false;
  const arrays = ["readtimeAwards", "readdayAwards", "readgoalAwards"];
  for (const arr of arrays) {
    for (const a of data[arr] || []) {
      if (a && a.awardLevelId === levelId) {
        if (a.awardStatus === 2) return true;
        // 某些情况下 awardChooseType 已更新但 status 未同步，作兜底判断
        if (a.awardChooseType === choiceType && a.awardStatus !== 0) return true;
      }
    }
  }
  return false;
}

function buildQueryBody() {
  return {
    awardLevelId: 0,
    unread: 0,
    isExchangeAward: 0,
    pf: PF,
    isVisitReadGoal: 1,
    awardChoiceType: 0
  };
}

async function notifyDone(index, item) {
  const r = merge.Weekly || {};
  if (r.notify) {
    console.log("\n" + r.notify);
    $nobyda.notify("微信读书我的阅读", shortVid(item.vid), r.notify);
  }
}

/* ========================= 凭证读取（与 WeRead_DailyBonus.js 共享 prefs） ========================= */

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
      if (isValidCookie(o)) list.unshift(o);
    } catch (e) {}
  }
  return list.filter(isValidCookie);
}

function shortVid(v) {
  const s = String(v || "");
  return s.slice(0, 6) + "…" + s.slice(-4);
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

/* ========================= 续期 ========================= */

function isSessionExpired(obj) {
  if (obj && typeof obj === "object") {
    const code = obj.errCode != null ? obj.errCode : obj.errcode;
    if (code === -2012 || code === "-2012" || code === -2013 || code === "-2013") return true;
  }
  return false;
}

function tryRenew(item) {
  return new Promise((resolve) => {
    const entry = findLoginEntry(item.vid);
    if (!entry) {
      console.log("[WeRead weekly renew] no loginBody, skip auto-renew");
      resolve(false);
      return;
    }
    const headers = {
      "Content-Type": entry.contentType || "application/x-www-form-urlencoded",
      vid: item.vid,
      v: BASEVER,
      Accept: "*/*",
      "User-Agent": DefaultUA,
      "Accept-Language": "zh-Hans-CN;q=1, en-CN;q=0.9, zh-Hant-CN;q=0.8",
      "Accept-Encoding": "gzip"
    };
    $nobyda.post(
      { url: "https://i.weread.qq.com/login", headers: headers, body: entry.body, timeout: out },
      (error, response, raw) => {
        try {
          const obj = safeJSON(raw);
          const newSkey = obj && (obj.skey || (obj.data && obj.data.skey) || obj.accessToken);
          if (newSkey) {
            item.skey = String(newSkey);
            persistSkey(item);
            console.log("[WeRead weekly renew] skey refreshed -> " + shortVid(newSkey));
            resolve(true);
          } else {
            console.log("[WeRead weekly renew] failed: " + String(raw).slice(0, 200));
            resolve(false);
          }
        } catch (e) {
          console.log("[WeRead weekly renew] " + e);
          resolve(false);
        }
      }
    );
  });
}

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
  } catch (e) {}
}

/* ========================= HTTP ========================= */

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
    const options = { url, headers: weReadHeaders(item, false), timeout: out };
    $nobyda.get(options, function (error, response, data) {
      if (error) reject(new Error(error));
      else resolve(data);
    });
  });
}

function httpPost(url, bodyObj, item) {
  return new Promise((resolve, reject) => {
    const options = {
      url,
      headers: weReadHeaders(item, true),
      body: JSON.stringify(bodyObj),
      timeout: out
    };
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
      if (response.status) response["statusCode"] = response.status;
      else if (response.statusCode) response["status"] = response.statusCode;
    }
    return response;
  };
  const get = (options, callback) => {
    if (isQuanX) {
      if (typeof options == "string") options = { url: options };
      options["method"] = "GET";
      $task.fetch(options).then(
        (response) => callback(null, adapterStatus(response), response.body),
        (reason) => callback(reason.error, null, null)
      );
    }
    if (isSurge)
      $httpClient.get(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    if (isNode) {
      node.request.get(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    }
  };
  const post = (options, callback) => {
    if (isQuanX) {
      if (typeof options == "string") options = { url: options };
      options["method"] = "POST";
      $task.fetch(options).then(
        (response) => callback(null, adapterStatus(response), response.body),
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
  const time = () => {
    const end = ((Date.now() - start) / 1000).toFixed(2);
    if (isQuanX) console.log("用时: " + end + " 秒");
    if (isSurge) console.log("用时: " + end + " 秒");
    if (isNode) console.log("用时: " + end + " 秒");
    if (isJSBox) console.log("用时: " + end + " 秒");
  };
  const done = (data) => {
    if (isQuanX) $done(data);
    if (isSurge) isRequest ? $done(data) : ($done != undefined ? $done(data) : undefined);
    if (isLoon) isRequest ? $done(data) : $done();
    if (isNode) process.exit(0);
  };
  const AnError = (name, keyname, er, resp, body) => {
    if (typeof merge !== "undefined" && merge[keyname]) {
      if (!merge[keyname].error) merge[keyname].error = 0;
      if (er) merge[keyname].error += 1;
      if (resp && resp.statusCode) merge[keyname].status_code = resp.statusCode;
      if (body) merge[keyname].body = body;
    }
  };
  return { isRequest, isQuanX, isSurge, isNode, notify, write, read, get, post, time, done, AnError };
}
