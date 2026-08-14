/*************************

  无忧行(JegoTrip) 每日签到脚本

  更新时间: 2026-08-14 (capture-v1-token+AES-userSign)
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  流量结论（抓包 2026-08-13-173934）:
  - 主机: app.jegotrip.com.cn
  - 查询: POST /api/service/v1/mission/sign/querySign?token=...&lang=zh_CN  body: {}
  - 签到: POST /api/service/v1/mission/sign/userSign?token=...&lang=zh_CN
  - 签到明文: {"signConfigId":<id>} ，外层 AES-ECB 加密为 {sec,body}
  - 密钥材料: secretKey=online_jego_h5 secretVal=93EFE107DDE6DE51（H5 missioncenter）
  - 对照: token d6f118... 签到 +8；token 3406f6... 签到 +6（用户手机号 137x / 133x）

  用法:
  1) 挂 rewrite，登录无忧行 → 打开「任务中心/签到」页（触发带 token 的请求）
  2) 通知「凭证已保存」后，手动/定时跑 task
  3) 多账号: 多设备或切换账号进入签到页，脚本按 token 去重累计

*************************

【推荐挂载 · Quantumult X】
----------------
重写引用:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/JegoTrip_DailyBonus.conf

任务引用:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/JegoTrip_DailyBonus.task

脚本本体:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/JegoTrip_DailyBonus.js

*************************/

var LogDetails = false;
var DeleteCookie = false;
var Notify = true;
var out = 0;

var $nobyda = nobyda();
var DefaultUA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
var PREFIX = "JegoTrip";
var HOST = "app.jegotrip.com.cn";
var SECRET_KEY = "online_jego_h5";
var SECRET_VAL = "93EFE107DDE6DE51";
var SECRET_VER = "01";

// Node / 手动: 逗号或换行分隔 token；或 JSON 数组 [{"token":"...","name":"137..."}]
var OtherKey = ``;

var merge = {};

(async () => {
  try {
    if (DeleteCookie) {
      ["_Cookie", "_Cookies", "_CaptureDiag", "_LastReplay"].forEach((s) => {
        $nobyda.write("", PREFIX + s);
      });
      throw new Error("已清除无忧行签到凭证，请重新打开 App 签到页抓取 ‼️");
    }

    if ($nobyda.isRequest) {
      GetCookie();
      return;
    }

    const cookies = ReadCookies();
    if (!cookies.length) throw new Error(buildNoCookieTip());

    for (let i = 0; i < cookies.length; i++) {
      await all(cookies[i], i + 1);
    }
  } catch (e) {
    $nobyda.notify("无忧行签到", "", String(e.message || e));
    console.log("\n" + (e.stack || e));
  } finally {
    $nobyda.time();
    $nobyda.done();
  }
})();

function isValidCookie(item) {
  if (!item || !item.token) return false;
  return /^[a-f0-9]{16,64}$/i.test(String(item.token));
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
      list.unshift({ token: one });
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
      const k = String(item.token).toLowerCase();
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
    .map((token) => ({ token }));
}

function normalizeCookie(input) {
  if (!input) return null;
  if (typeof input === "object") {
    const token = String(input.token || input.request || "").trim();
    if (!token) return null;
    return {
      token,
      name: input.name || input.phone || shortToken(token),
      host: (input.host || HOST).replace(/^https?:\/\//, "").replace(/\/$/, ""),
      update: input.update || ""
    };
  }
  const text = String(input).trim();
  if (!text) return null;
  if (text[0] === "{" || text[0] === "[") {
    try {
      return normalizeCookie(JSON.parse(text));
    } catch (e) {}
  }
  return { token: text, name: shortToken(text), host: HOST };
}

function shortToken(t) {
  const s = String(t || "");
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
      const token = cookieItem.token;
      const host = cookieItem.host || HOST;

      // 1) querySign — 明文 JSON
      const queryUrl =
        "https://" + host + "/api/service/v1/mission/sign/querySign?token=" + encodeURIComponent(token) + "&lang=zh_CN";
      const qRaw = await httpPost(queryUrl, "{}");
      const qObj = safeJSON(qRaw);
      if (!qObj) throw new Error("querySign 响应非 JSON");
      if (String(qObj.code) === "468" || /登录/.test(String(qObj.msg || ""))) {
        merge.Sign.notify = "无忧行签到: token 失效，请重新进签到页抓取 ‼️";
        merge.Sign.fail = 1;
        return;
      }
      if (String(qObj.code) !== "0" && String(qObj.code) !== "200") {
        merge.Sign.notify = "无忧行签到: 查询失败 " + (qObj.msg || qObj.code) + " ‼️";
        merge.Sign.fail = 1;
        return;
      }

      const calendar = Array.isArray(qObj.body) ? qObj.body : [];
      const todayDone = calendar.find((x) => String(x.isSign) === "3");
      if (todayDone) {
        const coin = todayDone.rewardCoin || "";
        merge.Sign.notify =
          "无忧行签到: 今日已签 ✅" +
          (coin ? "（配置 " + coin + " 无忧币档）" : "") +
          "\n连签第 " +
          (todayDone.completeNumber || "?") +
          " 天";
        merge.Sign.success = 1;
        return;
      }

      const next = pickNextSignConfig(calendar);
      if (!next) {
        merge.Sign.notify = "无忧行签到: 无可签配置（日历为空或已全部完成） ⚠️";
        merge.Sign.fail = 1;
        return;
      }

      // 2) userSign — AES 加密 body
      const plain = { signConfigId: next.id };
      const enc = JegoEncrypt(plain);
      const signUrl =
        "https://" + host + "/api/service/v1/mission/sign/userSign?token=" + encodeURIComponent(token) + "&lang=zh_CN";
      const sRaw = await httpPost(signUrl, JSON.stringify(enc));
      const sObj = safeJSON(sRaw);
      writeReplayMeta(sRaw, sObj);

      if (!sObj) {
        merge.Sign.notify = "无忧行签到: 签到响应非 JSON ‼️\n" + String(sRaw).slice(0, 120);
        merge.Sign.fail = 1;
        return;
      }
      if (String(sObj.code) === "468" || /登录/.test(String(sObj.msg || ""))) {
        merge.Sign.notify = "无忧行签到: token 失效 ‼️";
        merge.Sign.fail = 1;
        return;
      }
      if (String(sObj.code) !== "0") {
        // 已签 / 失败
        if (/已签|重复|签过/.test(String(sObj.msg || ""))) {
          merge.Sign.notify = "无忧行签到: 已签到过 ✅ (" + (sObj.msg || "") + ")";
          merge.Sign.success = 1;
          return;
        }
        merge.Sign.notify = "无忧行签到: 失败 " + (sObj.msg || sObj.code) + " ‼️";
        merge.Sign.fail = 1;
        return;
      }

      let rewardText = "";
      if (sObj.body && sObj.sec) {
        try {
          const dec = JegoDecrypt(sObj.sec, sObj.body);
          const d = typeof dec === "string" ? safeJSON(dec) || { raw: dec } : dec;
          if (d) {
            const qty = d.rewardQuantity || d.rewardCoin || "";
            const name = d.rewardName || "无忧币";
            if (qty !== "" && qty != null) rewardText = " +" + qty + " " + name;
            else if (d.bizMsg) rewardText = " " + d.bizMsg;
            if (LogDetails) console.log("[userSign dec] " + JSON.stringify(d));
          }
        } catch (e) {
          console.log("[decrypt resp] " + e);
        }
      }
      if (!rewardText) rewardText = " 预期 +" + (next.rewardCoin || "?") + " 无忧币";

      merge.Sign.notify =
        "无忧行签到: 成功 ✅" +
        rewardText +
        "\n连签第 " +
        (next.completeNumber || "?") +
        " 天 (signConfigId=" +
        next.id +
        ")";
      merge.Sign.success = 1;

      // 3) 可选：积分余额
      try {
        const cUrl =
          "https://" + host + "/api/service/user/v1/getUserTripCoins?token=" + encodeURIComponent(token) + "&lang=zh_CN";
        const cRaw = await httpPost(cUrl, "{}");
        const cObj = safeJSON(cRaw);
        if (cObj && cObj.body && cObj.body.tripCoins != null) {
          merge.Sign.notify += "\n当前无忧币: " + cObj.body.tripCoins;
        }
      } catch (e) {}
    } catch (eor) {
      merge.Sign.notify = "无忧行签到: 异常 " + (eor.message || eor) + " ‼️";
      merge.Sign.fail = 1;
      console.log(eor.stack || eor);
    }
  })();
}

function pickNextSignConfig(calendar) {
  if (!Array.isArray(calendar) || !calendar.length) return null;
  // isSign: 1=历史已完成, 2=待签候选, 3=今日已签
  const cands = calendar
    .filter((x) => x && String(x.isSign) === "2")
    .sort((a, b) => Number(a.completeNumber || 99) - Number(b.completeNumber || 99));
  return cands[0] || null;
}

function notifyDone(index, cookieItem) {
  return new Promise((resolve) => {
    const title = "无忧行签到";
    const sub = (cookieItem && cookieItem.name) || "#" + index;
    const msg = (merge.Sign && merge.Sign.notify) || "无明细";
    if (Notify) $nobyda.notify(title, sub, msg);
    console.log("\n" + title + "\n" + sub + "\n" + msg);
    resolve();
  });
}

function buildNoCookieTip() {
  return (
    "未获取到无忧行 token\n" +
    "1) 更新并启用 rewrite: JegoTrip_DailyBonus.conf\n" +
    "2) 信任 MitM 证书（hostname 含 app.jegotrip.com.cn）\n" +
    "3) 打开无忧行 → 任务中心/签到页\n" +
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
    if (!/jegotrip\.com\.cn/i.test(url)) {
      $nobyda.done({});
      return;
    }
    // 跳过预检
    if (/^OPTIONS/i.test(String(req.method || ""))) {
      $nobyda.done({});
      return;
    }

    const token = extractToken(url);
    const hostRaw = (req.headers && (req.headers.Host || req.headers.host)) || "";
    const host = String(hostRaw).replace(/:\d+$/, "") || HOST;
    const method = req.method || "";
    const diag =
      new Date().toISOString() +
      " | " +
      method +
      " | host=" +
      host +
      " | token=" +
      (token ? token.slice(0, 8) + "…" : "-") +
      " | url=" +
      url.slice(0, 160);
    console.log("[JegoTrip capture] " + diag);
    appendDiag(diag);

    if (!token || !isValidCookie({ token })) {
      $nobyda.done({});
      return;
    }

    // 仅在任务/签到相关或含 token 的 app 接口入库，避免埋点噪声刷屏
    const signLike = /\/mission\/|\/member\/|getUserTripCoins|userSign|querySign/i.test(url);
    if (!signLike && !/app\.jegotrip\.com\.cn|app3\.jegotrip\.com\.cn/i.test(host)) {
      $nobyda.done({});
      return;
    }

    const item = {
      token,
      name: shortToken(token),
      host: /app\.jegotrip\.com\.cn/i.test(host) ? "app.jegotrip.com.cn" : HOST,
      update: new Date().toISOString(),
      lastUrl: url.slice(0, 200)
    };

    const saved = saveCookie(item);
    if (saved === "new") {
      $nobyda.notify("无忧行签到", item.name, "凭证新增 ✅\ntoken=" + shortToken(token));
    } else if (saved === "update") {
      if (LogDetails) $nobyda.notify("无忧行签到", item.name, "凭证已更新");
      console.log("[JegoTrip] cookie updated " + item.name);
    }
    $nobyda.done({});
  } catch (e) {
    console.log("[GetCookie] " + e);
    $nobyda.done({});
  }
}

function extractToken(url) {
  try {
    const m = String(url).match(/[?&]token=([a-f0-9]{16,64})/i);
    return m ? m[1] : "";
  } catch (e) {
    return "";
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
  const key = item.token.toLowerCase();
  let found = false;
  let changed = false;
  list = list.map((x) => {
    if (x && String(x.token || "").toLowerCase() === key) {
      found = true;
      const merged = Object.assign({}, x, item);
      // 保留用户自定义 name（非短 token 形态）
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

function writeReplayMeta(raw, obj) {
  try {
    $nobyda.write(
      JSON.stringify({
        at: new Date().toISOString(),
        code: obj && obj.code,
        msg: obj && obj.msg,
        head: String(raw || "").slice(0, 180)
      }),
      PREFIX + "_LastReplay"
    );
  } catch (e) {}
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const options = {
      url,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: "https://cdn.jegotrip.com.cn",
        Referer: "https://cdn.jegotrip.com.cn/",
        "User-Agent": DefaultUA
      },
      body: typeof body === "string" ? body : JSON.stringify(body || {})
    };
    if (out) options.timeout = out;
    $nobyda.post(options, function (error, response, data) {
      if (error) reject(new Error(error));
      else resolve(data);
    });
  });
}

function appendDiag(line) {
  try {
    const prev = $nobyda.read(PREFIX + "_CaptureDiag") || "";
    const next = (line + "\n" + prev).split("\n").slice(0, 30).join("\n");
    $nobyda.write(next, PREFIX + "_CaptureDiag");
  } catch (e) {}
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

/* ========================= Jego AES (MD5 + AES-ECB PKCS7) ========================= */

function JegoEncrypt(obj) {
  const ts = String(Date.now()) + String(Math.floor(900 * Math.random() + 100));
  const key = md5Hex(SECRET_VAL + ts).toLowerCase().slice(8, 24);
  const secPlain = SECRET_KEY + ";" + ts + ";" + SECRET_VER;
  const sec = b64EncodeUtf8(secPlain);
  const json = JSON.stringify(obj == null ? {} : obj);
  const body = aesEcbEncryptToB64(json, key);
  return { sec: sec, body: body };
}

function JegoDecrypt(secB64, bodyB64) {
  const secPlain = b64DecodeToUtf8(secB64);
  const parts = secPlain.split(";");
  if (parts.length < 2) throw new Error("bad sec");
  const key = md5Hex(SECRET_VAL + parts[1]).toLowerCase().slice(8, 24);
  return aesEcbDecryptFromB64(bodyB64, key);
}

function md5Hex(str) {
  // compact MD5
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  function md5cycle(x, k) {
    var a = x[0],
      b = x[1],
      c = x[2],
      d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }
  function md5blk(s) {
    var md5blks = [],
      i;
    for (i = 0; i < 64; i += 4) {
      md5blks[i >> 2] =
        s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }
  function md51(s) {
    var n = s.length,
      state = [1732584193, -271733879, -1732584194, 271733878],
      i,
      length,
      tail,
      tmp,
      lo,
      hi;
    for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
    s = s.substring(i - 64);
    length = s.length;
    tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < length; i++) tail[i >> 2] |= s.charCodeAt(i) << (i % 4 << 3);
    tail[i >> 2] |= 0x80 << (i % 4 << 3);
    if (i > 55) {
      md5cycle(state, tail);
      for (i = 0; i < 16; i++) tail[i] = 0;
    }
    tmp = n * 8;
    tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
    lo = parseInt(tmp[2], 16);
    hi = parseInt(tmp[1], 16) || 0;
    tail[14] = lo;
    tail[15] = hi;
    md5cycle(state, tail);
    return state;
  }
  function rhex(n) {
    var s = "",
      j;
    for (j = 0; j < 4; j++) s += ("0" + ((n >> (j * 8)) & 255).toString(16)).slice(-2);
    return s;
  }
  function add32(a, b) {
    return (a + b) & 0xffffffff;
  }
  var i,
    out = "",
    x = md51(unescape(encodeURIComponent(str)));
  for (i = 0; i < 4; i++) out += rhex(x[i]);
  return out;
}

// AES-128-ECB PKCS7 — pure JS (column-major; encrypt verified vs capture)
function aesEcbEncryptToB64(plainText, keyStr) {
  const data = pkcs7Pad(utf8ToBytes(plainText), 16);
  const cipher = aes128(utf8ToBytes(keyStr));
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) out.set(cipher.encrypt(data.subarray(i, i + 16)), i);
  return bytesToB64(out);
}

function aesEcbDecryptFromB64(b64, keyStr) {
  const data = b64ToBytes(b64);
  const cipher = aes128(utf8ToBytes(keyStr));
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) out.set(cipher.decrypt(data.subarray(i, i + 16)), i);
  return bytesToUtf8(pkcs7Unpad(out));
}

function pkcs7Pad(u8, block) {
  const pad = block - (u8.length % block);
  const out = new Uint8Array(u8.length + pad);
  out.set(u8);
  for (let i = u8.length; i < out.length; i++) out[i] = pad;
  return out;
}
function pkcs7Unpad(u8) {
  if (!u8.length) return u8;
  const pad = u8[u8.length - 1];
  if (pad < 1 || pad > 16) return u8;
  return u8.subarray(0, u8.length - pad);
}

function aes128(keyBytes) {
  const sbox = [99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22];
  const isbox = new Array(256);
  for (let i = 0; i < 256; i++) isbox[sbox[i]] = i;
  const Rcon = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
  function gmul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 255;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return p;
  }
  const Nk = 4, Nr = 10, Nb = 4;
  const w = new Uint32Array(Nb * (Nr + 1));
  for (let i = 0; i < Nk; i++) {
    w[i] =
      ((keyBytes[4 * i] << 24) |
        (keyBytes[4 * i + 1] << 16) |
        (keyBytes[4 * i + 2] << 8) |
        keyBytes[4 * i + 3]) >>> 0;
  }
  for (let i = Nk; i < Nb * (Nr + 1); i++) {
    let temp = w[i - 1];
    if (i % Nk === 0) {
      temp = ((temp << 8) | (temp >>> 24)) >>> 0;
      temp =
        ((sbox[(temp >>> 24) & 255] << 24) |
          (sbox[(temp >>> 16) & 255] << 16) |
          (sbox[(temp >>> 8) & 255] << 8) |
          sbox[temp & 255]) >>> 0;
      temp = (temp ^ (Rcon[i / Nk] << 24)) >>> 0;
    }
    w[i] = (w[i - Nk] ^ temp) >>> 0;
  }
  function addRK(state, round) {
    for (let c = 0; c < 4; c++) {
      const rk = w[round * 4 + c];
      state[0][c] ^= (rk >>> 24) & 255;
      state[1][c] ^= (rk >>> 16) & 255;
      state[2][c] ^= (rk >>> 8) & 255;
      state[3][c] ^= rk & 255;
    }
  }
  function subB(state, inv) {
    const box = inv ? isbox : sbox;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) state[r][c] = box[state[r][c]];
  }
  function shiftR(state, inv) {
    for (let r = 1; r < 4; r++) {
      const row = state[r].slice();
      for (let c = 0; c < 4; c++) state[r][c] = inv ? row[(c - r + 4) % 4] : row[(c + r) % 4];
    }
  }
  function mixC(state, inv) {
    for (let c = 0; c < 4; c++) {
      const a0 = state[0][c], a1 = state[1][c], a2 = state[2][c], a3 = state[3][c];
      if (!inv) {
        state[0][c] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
        state[1][c] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
        state[2][c] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
        state[3][c] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
      } else {
        state[0][c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        state[1][c] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        state[2][c] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        state[3][c] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
      }
    }
  }
  function toState(block) {
    const s = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
    for (let i = 0; i < 16; i++) s[i % 4][(i / 4) | 0] = block[i];
    return s;
  }
  function fromState(s) {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = s[i % 4][(i / 4) | 0];
    return out;
  }
  return {
    encrypt(block) {
      const state = toState(block);
      addRK(state, 0);
      for (let r = 1; r < Nr; r++) {
        subB(state, false); shiftR(state, false); mixC(state, false); addRK(state, r);
      }
      subB(state, false); shiftR(state, false); addRK(state, Nr);
      return fromState(state);
    },
    decrypt(block) {
      // 解密用于解析奖励文案；失败时脚本回退 rewardCoin
      // 等价于 encrypt 的逆，列主序状态机
      try {
        // reuse node-crypto path unavailable; use encrypt-round inverse tables
      } catch (e) {}
      const state = toState(block);
      addRK(state, Nr);
      for (let r = Nr - 1; r > 0; r--) {
        shiftR(state, true); subB(state, true); addRK(state, r); mixC(state, true);
      }
      shiftR(state, true); subB(state, true); addRK(state, 0);
      return fromState(state);
    }
  };
}

function utf8ToBytes(str) {
  const s = unescape(encodeURIComponent(String(str)));
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
function bytesToUtf8(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
}
function bytesToB64(u8) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i];
    const b = i + 1 < u8.length ? u8[i + 1] : 0;
    const c = i + 2 < u8.length ? u8[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    out += i + 1 < u8.length ? chars[(n >> 6) & 63] : "=";
    out += i + 2 < u8.length ? chars[n & 63] : "=";
  }
  return out;
}
function b64ToBytes(b64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let str = String(b64 || "").replace(/[^A-Za-z0-9\+\/]/g, "");
  const len = str.length;
  const padding = (str[len - 1] === "=") + (str[len - 2] === "=");
  const bytesLen = Math.floor((len * 3) / 4) - padding;
  const u8 = new Uint8Array(bytesLen);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const n =
      (chars.indexOf(str[i]) << 18) |
      (chars.indexOf(str[i + 1]) << 12) |
      ((str[i + 2] === "=" ? 0 : chars.indexOf(str[i + 2])) << 6) |
      (str[i + 3] === "=" ? 0 : chars.indexOf(str[i + 3]));
    if (p < bytesLen) u8[p++] = (n >> 16) & 255;
    if (p < bytesLen) u8[p++] = (n >> 8) & 255;
    if (p < bytesLen) u8[p++] = n & 255;
  }
  return u8;
}
function b64EncodeUtf8(str) {
  return bytesToB64(utf8ToBytes(str));
}
function b64DecodeToUtf8(b64) {
  return bytesToUtf8(b64ToBytes(b64));
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
        const path = "jegotrip_cookie.json";
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
        const path = "jegotrip_cookie.json";
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
