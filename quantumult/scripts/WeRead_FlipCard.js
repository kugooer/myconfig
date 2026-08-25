/*************************

  微信读书(WeRead) 每周翻一翻脚本

  更新时间: 2026-08-25 (capture-v1.0)
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  capture-v1.0: 初版。复用 WeRead_Cookies / WeRead_LoginBody 凭证(由
                WeRead_DailyBonus.js 统一抓取，capture-v1.3 起覆盖
                flip-card-game/api 路径, 打开翻一翻页即抓 Cookie 凭证)。
                每周二 8:10 定时翻 6 张卡 + 接收 cardList 奖品。

  流量结论（抓包 2026-08-24-094839）:
  - 翻牌: GET https://weread.qq.com/flip-card-game/api/flipCardFlip
    ?cardIndex=N&giftIndex=N&pf=ios&platform=ios_html
    → 响应: { remainingCount, userType, cardList: [...] }
    → 每周二 8:00 刷新 6 次翻卡次数，本接口按 cardIndex 自增翻
  - 接收: GET https://weread.qq.com/flip-card-game/api/flipCardReceive
    ?cardIndex=N&giftIndex=N&pf=ios&platform=ios_html
    → 响应: { cardList: [...] }（每张卡的 status: 0=未领 3=已领）
  - 认证: 仅 Cookie (wr_skey=...; wr_vid=...)，无独立 vid/skey header
  - 注意: cardType 有 infinite(1 天体验卡) / book(赠书) / coin(翻币)
    status=3+autoReceive=1 的卡已自动领, 无需再 receive

  用法:
  1) 同 WeRead_DailyBonus 复用 rewrite/WeRead_DailyBonus.conf(已含
     flip-card-game/api 路径, 打开翻一翻页即抓/更新 Cookie 凭证)
  2) 挂 task/WeRead_FlipCard.task → 每周二 08:10 自动执行
  3) 首次需打开「翻一翻」页面让 rewrite 抓一次 Cookie 凭证
  4) 后续自动续期: 翻一翻流程遇 -2012 时复用 WeRead_LoginBody 续期

*************************/

var PREFIX = "WeRead";
var HOST = "weread.qq.com";
var CHANNEL_ID = "AppStore";
var BASEVER = "10.2.1.87";
var DefaultUA = "WeRead/10.2.1 (iPhone; iOS 26.4.1; Scale/3.00)";

var API_FEATURED_BOOK = "https://weread.qq.com/flip-card-game/api/featuredBook?platform=ios_html";
var API_FLIP = "https://weread.qq.com/flip-card-game/api/flipCardFlip?platform=ios_html";
var API_RECEIVE = "https://weread.qq.com/flip-card-game/api/flipCardReceive?platform=ios_html";
var API_LOGIN = "https://i.weread.qq.com/login";

var MAX_FLIPS = 6;       // 每周二刷新 6 次翻卡次数
var out = 15000;         // 请求超时(ms)
var LogDetails = false;  // 详细日志
var DeleteCookie = false;
var merge = {};

// 适配层初始化（放 IIFE 之前；nobyda 函数声明被 hoisted）
var $nobyda = nobyda();

/* ========================= 主流程 ========================= */

(async () => {
  try {
    if (DeleteCookie) {
      ["WeRead_Cookie", "WeRead_Cookies", "WeRead_LoginBody", "WeRead_FlipDiag"].forEach((s) => {
        $nobyda.write("", s);
      });
      throw new Error("已清除微信读书翻一翻凭证，请重新打开微信读书 App「翻一翻」页面抓取 ‼️");
    }

    const cookies = ReadCookies();
    if (!cookies.length) {
      throw new Error(
        "未获取到微信读书凭证\n" +
        "1) 更新并启用 rewrite: WeRead_DailyBonus.conf (capture-v1.3+，含 flip-card-game/api)\n" +
        "2) 信任 MitM 证书（hostname 含 weread.qq.com / i.weread.qq.com）\n" +
        "3) 打开微信读书 App → 「翻一翻」页面（自动抓 Cookie 凭证）\n" +
        "4) 看到「凭证已保存」后再跑定时任务"
      );
    }

    for (let i = 0; i < cookies.length; i++) {
      await all(cookies[i], i + 1);
    }
  } catch (e) {
    if (!$nobyda.isRequest) {
      $nobyda.notify("微信读书翻一翻", "", String(e.message || e));
      console.log("\n" + (e.stack || e));
    } else {
      console.log("[WeRead flip] capture err " + (e.message || e));
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
    // 与 WeRead_DailyBonus.js 一样，遇会话过期自动续期
    if (item.loginBody) {
      const renewed = await tryRenew(item);
      if (renewed) console.log("[WeRead flip] skey refreshed -> " + shortVid(item.skey));
    }
    await doFlip(item);
    await notifyDone(index, item);
  })();
}

async function doFlip(item) {
  merge.Flip = {};
  let totalFlipped = 0;
  let rewards = [];
  try {
    // 取一次 featuredBook（让服务端感知 + 探查当前周期）
    try {
      await httpGet(API_FEATURED_BOOK, item);
    } catch (e) {
      console.log("[WeRead flip] featuredBook warn: " + e.message);
    }

    // 翻 6 张卡
    // giftIndex 与 cardIndex 配对：从 0 开始
    let lastResp = null;
    for (let i = 1; i <= MAX_FLIPS; i++) {
      const url = API_FLIP + "&cardIndex=" + i + "&giftIndex=" + (i - 1) + "&pf=ios";
      let resp;
      try {
        const raw = await httpGet(url, item);
        resp = safeJSON(raw);
      } catch (e) {
        console.log("[WeRead flip] flip #" + i + " err: " + e.message);
        break;
      }
      if (!resp) {
        console.log("[WeRead flip] flip #" + i + " empty body, stop");
        break;
      }
      // 会话过期: 尝试续期一次后重试
      if (isSessionExpired(resp)) {
        const renewed = await tryRenew(item);
        if (renewed) {
          try {
            const raw2 = await httpGet(url, item);
            resp = safeJSON(raw2);
          } catch (e) {
            console.log("[WeRead flip] flip #" + i + " retry err: " + e.message);
            break;
          }
        } else {
          merge.Flip.fail = 1;
          merge.Flip.notify = "微信读书翻一翻: skey 已过期且自动续期失败 ‼️\n请重新打开 App 抓取凭证";
          return;
        }
      }
      totalFlipped++;
      lastResp = resp;
      const remain = resp.remainingCount;
      if (LogDetails) console.log("[WeRead flip] #" + i + " remaining=" + remain + " cards=" + (resp.cardList || []).length);
      if (typeof remain === "number" && remain <= 0) break;
    }

    // 收集已翻卡 + 接收所有未领卡
    const cardList = (lastResp && lastResp.cardList) || [];
    if (!cardList.length) {
      // 可能本周还没刷新次数（不是周二），或已翻过
      merge.Flip.success = 1;
      merge.Flip.notify = "微信读书翻一翻: 本期无卡可翻（每周二 8:00 刷新 6 次）";
      return;
    }

    let received = 0;
    for (let i = 0; i < cardList.length; i++) {
      const card = cardList[i];
      if (!card || typeof card.cardIndex !== "number") continue;
      const gift = describeCard(card);
      if (gift) rewards.push(gift);
      // status=3 表示已领取（自动或手动）；其余调 receive
      if (card.status === 3) continue;
      if (card.autoReceive === 1) continue; // 服务端已自动领
      const gi = getGiftIndex(card, cardList);
      const rurl = API_RECEIVE + "&cardIndex=" + card.cardIndex + "&giftIndex=" + gi + "&pf=ios";
      try {
        const rraw = await httpGet(rurl, item);
        const r = safeJSON(rraw);
        if (r) {
          if (isSessionExpired(r)) {
            const renewed = await tryRenew(item);
            if (renewed) {
              try {
                await httpGet(rurl, item);
              } catch (e) {}
            }
          } else {
            // 更新后的 cardList 可能包含更多卡
          }
        }
        received++;
        if (LogDetails) console.log("[WeRead flip] receive cardIndex=" + card.cardIndex);
      } catch (e) {
        console.log("[WeRead flip] receive err idx=" + card.cardIndex + " " + e.message);
      }
    }

    merge.Flip.success = 1;
    const rewardText = rewards.length ? rewards.map((g) => "• " + g).join("\n") : "（已翻完，详见 App）";
    merge.Flip.notify =
      "微信读书翻一翻: 成功 ✅\n" +
      "翻了 " + totalFlipped + " 张，领取 " + received + " 张\n" +
      "本周奖品:\n" + rewardText;
  } catch (e) {
    merge.Flip.fail = 1;
    merge.Flip.notify = "微信读书翻一翻: 失败 ‼️\n" + String(e.message || e);
    console.log("[WeRead flip] " + e);
  }
}

function describeCard(card) {
  if (!card) return null;
  // cardType: infinite(1 天体验卡) / book(赠书) / coin(翻币)
  if (card.cardType === "infinite" || card.infinite) {
    return "1 天体验卡 × 1";
  }
  if (card.cardType === "book" && card.bookInfo) {
    const title = card.bookInfo.title || "未知书目";
    return "赠书 《" + title + "》";
  }
  if (card.cardType === "coin" || card.coin || card.flipCoin) {
    const n = card.coin || card.flipCoin || 0;
    return "翻币 × " + n;
  }
  if (card.bookInfo && card.bookInfo.title) {
    return "赠书 《" + card.bookInfo.title + "》";
  }
  if (card.name) return card.name;
  if (card.desc) return card.desc;
  return null;
}

function getGiftIndex(card, cardList) {
  // giftIndex = 该卡在 cardList 中的位置（0-based）
  for (let i = 0; i < cardList.length; i++) {
    if (cardList[i] && cardList[i].cardIndex === card.cardIndex) return i;
  }
  return 0;
}

async function notifyDone(index, item) {
  const k = Object.keys(merge)[0];
  const r = merge[k] || {};
  if (r.notify) {
    console.log("\n" + r.notify);
    $nobyda.notify("微信读书翻一翻", shortVid(item.vid) + " " + (k || ""), r.notify);
  } else if (r.fail) {
    console.log("\n" + r.notify);
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
      console.log("[WeRead flip renew] no loginBody, skip auto-renew");
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
      { url: API_LOGIN, headers: headers, body: entry.body, timeout: out },
      (error, response, raw) => {
        try {
          const obj = safeJSON(raw);
          const newSkey = obj && (obj.skey || (obj.data && obj.data.skey) || (obj.accessToken));
          if (newSkey) {
            item.skey = String(newSkey);
            persistSkey(item);
            console.log("[WeRead flip renew] skey refreshed -> " + shortVid(newSkey));
            resolve(true);
          } else {
            console.log("[WeRead flip renew] failed: " + String(raw).slice(0, 200));
            resolve(false);
          }
        } catch (e) {
          console.log("[WeRead flip renew] " + e);
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
    if (isQuanX) console.log("签到用时: " + end + " 秒");
    if (isSurge) console.log("签到用时: " + end + " 秒");
    if (isNode) console.log("签到用时: " + end + " 秒");
    if (isJSBox) console.log("签到用时: " + end + " 秒");
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
