/*************************

  中国联通 App 每日签到脚本

  更新时间: 2026-09-28 (capture-v1)
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  接口定性 (2026-09-28 抓包实证):
  - 主机: activity.10010.com (H5 WebView, 纯 Cookie 认证, 明文 JSON, 无加密)
  - Cookie 发放: m.client.10010.com/mobileService/onLine.htm (每次启动刷新 c_id/ecs_acc, 旧会话短期仍有效)
  - 抓取触发: 打开联通 App 首页即自动加载签到页(channel=shouye) → 命中 rewrite
  - POST /sixPalaceGridTurntableLottery/signin/daySign  body: shareCl=&shareCode=
      code 0000 = 签到成功(data.redSignMessage 如 "+0.01元")
      code 0002 = 今日已签到
  - GET  /sixPalaceGridTurntableLottery/floor/getMonthSign
      data.taskList[] taskStatus 0=未达条件 1=可领 2=已领
  - GET  /sixPalaceGridTurntableLottery/task/getTaskReward?taskId=<t>&taskType=30&id=<id>  领月签奖励
  - GET  /sixPalaceGridTurntableLottery/signin/getIntegral  data.integralTotal 积分余额(只读探针)

  挂载 (Quantumult X):
  重写: https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/Unicom_DailyBonus.conf
  任务: https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/Unicom_DailyBonus.task

  注意: 仅用于本人账号签到/领奖; 禁止用于任何解锁类用途

*************************/

var LogDetails = false;
var DeleteCookie = false;
var Notify = true;
var out = 0;

var $nobyda = nobyda();
var PREFIX = "UNICOM";
var HOST = "activity.10010.com";
// 与 Unicom_DailyBonus.conf 的正则保持同步
var CAPTURE_RE = /^https:\/\/activity\.10010\.com\/sixPalaceGridTurntableLottery\/(?:signin\/|task\/|floor\/getMonthSign)/;
var merge = {};

(async () => {
  try {
    if (DeleteCookie) {
      ["_Cookie", "_CaptureDiag"].forEach((s) => {
        $nobyda.write("", PREFIX + s);
      });
      throw new Error("已清除联通凭证，请重新打开联通 App 抓取 ‼️");
    }

    if ($nobyda.isRequest) {
      GetCookie();
      return;
    }

    const cookie = ReadCookie();
    if (!cookie) throw new Error(buildNoCookieTip());
    await all(cookie);
  } catch (e) {
    $nobyda.notify("联通签到", "", String(e.message || e));
    console.log("\n" + (e.stack || e));
  } finally {
    $nobyda.time();
    $nobyda.done();
  }
})();

// ---------- 抓取 ----------

function GetCookie() {
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      $nobyda.done({});
    }
  };
  try {
    const req = typeof $request !== "undefined" ? $request : null;
    if (!req || !req.url) return release();
    const url = String(req.url || "");
    if (!CAPTURE_RE.test(url)) return release();

    const rawCookie = getHeader(req.headers, "Cookie") || getHeader(req.headers, "cookie") || "";
    // 合法性过滤: 必须带 c_id + ecs_acc/ecs_token, 排除未登录态
    if (!/c_id=[^;]+/.test(rawCookie) || !/(ecs_acc|ecs_token)=[^;]+/.test(rawCookie)) {
      console.log("[UNICOM capture] cookie 不完整, 跳过 | url=" + url.slice(0, 120));
      return release();
    }

    const ua = getHeader(req.headers, "User-Agent") || getHeader(req.headers, "user-agent") || "";
    const item = {
      cookie: rawCookie.trim(),
      ua: ua.trim(),
      from: url.slice(0, 160),
      update: nowISO()
    };

    const old = ReadCookie();
    if (old && old.cookie === item.cookie) {
      console.log("[UNICOM capture] same, 静默");
      return release();
    }
    const isNew = !old;
    $nobyda.write(JSON.stringify(item), PREFIX + "_Cookie");
    appendDiag(
      nowISO() + " | " + (isNew ? "new" : "update") + " | c_id=" +
      (rawCookie.match(/c_id=([^;]{1,12})/) || ["", "-"])[1] + "... | " + url.slice(0, 100)
    );
    // 刷屏控制: 仅首次抓取通知, 之后静默更新
    if (isNew && Notify) {
      $nobyda.notify("联通签到", "", "首次获取签到 Cookie 成功 ✅\n可在明早定时任务验证签到");
    }
    console.log("[UNICOM capture] " + (isNew ? "new" : "update") + " ok");
  } catch (e) {
    console.log("[GetCookie] " + e);
  } finally {
    release();
  }
}

function ReadCookie() {
  try {
    const one = $nobyda.read(PREFIX + "_Cookie");
    if (!one) return null;
    const o = JSON.parse(one);
    if (o && o.cookie && /c_id=/.test(o.cookie)) return o;
    return null;
  } catch (e) {
    return null;
  }
}

// ---------- 签到主流程 ----------

async function all(ck) {
  const headers = buildHeaders(ck);
  merge.Integral = "";
  merge.SignNotify = "";
  merge.MonthNotify = "";
  merge.Failed = 0;

  // 1) 只读探针: 判凭证有效性 + 拿积分余额
  const probe = await getJSON(headers, "/signin/getIntegral");
  if (probe && probe.code === "0000") {
    merge.Integral = (probe.data && probe.data.integralTotal) || "";
  } else {
    // 凭证失效(或服务端异常): 不再继续, 直接提示重抓
    merge.Failed = 1;
    const msg =
      "凭证校验失败 ❌\n响应: " + JSON.stringify(probe).slice(0, 120) +
      "\n请打开一次联通 App 刷新凭证";
    $nobyda.notify("联通签到", "凭证无效", msg);
    console.log("[UNICOM] probe fail: " + JSON.stringify(probe));
    return;
  }

  // 2) 每日签到
  const sign = await postJSON(headers, "/signin/daySign", "shareCl=&shareCode=");
  if (sign && sign.code === "0000") {
    const reward = (sign.data && (sign.data.redSignMessage || sign.data.statusDesc)) || "成功";
    merge.SignNotify = "✅ 签到成功 " + reward;
  } else if (sign && sign.code === "0002") {
    merge.SignNotify = "☑️ 今日已签到";
  } else {
    merge.Failed = 1;
    merge.SignNotify = "❌ 签到失败: " + (sign ? sign.desc || sign.code : "无响应");
  }

  // 3) 月签有礼: taskStatus==1 的领取
  const month = await getJSON(headers, "/floor/getMonthSign");
  let claimed = 0;
  let claimMsg = "";
  const tasks = (month && month.data && month.data.taskList) || [];
  for (const t of tasks) {
    if (String(t.taskStatus) !== "1" || !t.taskId) continue;
    let q = "/task/getTaskReward?taskId=" + encodeURIComponent(t.taskId);
    if (t.id) q += "&taskType=30&id=" + encodeURIComponent(t.id);
    const r = await getJSON(headers, q);
    if (r && r.code === "0000" && r.data && r.data.code === "0000") {
      claimed++;
      claimMsg += "\n· " + (t.taskName || "月签") + " " + ((r.data && r.data.prizeNameRed) || (r.data && r.data.prizeCount) || "");
    } else {
      console.log("[UNICOM] month claim fail " + t.taskName + ": " + JSON.stringify(r).slice(0, 150));
    }
    await sleep(800);
  }
  if (tasks.length) {
    merge.MonthNotify = claimed > 0
      ? "🎁 月签领取 " + claimed + " 项" + claimMsg
      : "🎁 月签暂无可领";
  }

  // 4) 汇总通知
  const sub = merge.Integral ? "积分 " + merge.Integral : "";
  const msg = [merge.SignNotify, merge.MonthNotify].filter(Boolean).join("\n") || "无明细";
  if (Notify) {
    $nobyda.notify("联通签到", sub, msg + (merge.Failed ? "\n‼️ 存在失败项" : ""));
  }
  console.log("\n联通签到\n" + sub + "\n" + msg);
}

function buildHeaders(ck) {
  const h = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://img.client.10010.com",
    Referer: "https://img.client.10010.com/SigininApp/index.html",
    Cookie: ck.cookie
  };
  if (ck.ua) h["User-Agent"] = ck.ua;
  return h;
}

function getJSON(headers, path) {
  return requestJSON("GET", "https://" + HOST + "/sixPalaceGridTurntableLottery" + path, headers, null);
}

function postJSON(headers, path, body) {
  return requestJSON("POST", "https://" + HOST + "/sixPalaceGridTurntableLottery" + path, headers, body);
}

function requestJSON(method, url, headers, body) {
  return new Promise((resolve) => {
    const options = { url, headers: Object.assign({}, headers), method };
    if (body != null) options.body = body;
    else delete options.headers["Content-Type"]; // GET 无 body 时不强加 CT
    $nobyda.fetch(options, function (error, response, data) {
      if (error) {
        console.log("[UNICOM] " + method + " " + pathOf(url) + " error: " + error);
        resolve(null);
        return;
      }
      const st = response && (response.statusCode || response.status);
      const j = safeJSON(data);
      if (!j) console.log("[UNICOM] " + method + " " + pathOf(url) + " http=" + st + " 非JSON: " + String(data).slice(0, 100));
      resolve(j);
    });
  });
}

function pathOf(url) {
  return String(url).replace(/^https?:\/\/[^/]+/, "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 工具 ----------

function getHeader(headers, name) {
  if (!headers) return "";
  if (headers[name]) return String(headers[name]);
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? String(headers[k]) : "";
}

function buildNoCookieTip() {
  return (
    "未获取到联通签到 Cookie\n" +
    "1) 更新并启用 rewrite(Unicom_DailyBonus.conf)\n" +
    "2) 信任 MitM 证书\n" +
    "3) 打开联通 App(首页会自动加载签到页完成抓取)"
  );
}

function appendDiag(line) {
  try {
    const old = $nobyda.read(PREFIX + "_CaptureDiag") || "";
    const lines = String(old).split(/\n+/).map((s) => s.trim()).filter(Boolean);
    lines.unshift(line);
    $nobyda.write(lines.slice(0, 20).join("\n"), PREFIX + "_CaptureDiag");
  } catch (e) {}
}

function nowISO() {
  // 强制东八区 (QX JavaScriptCore 时区为 UTC)
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
}

function safeJSON(str) {
  try {
    const text = String(str).replace(/^[\s\S]*?(\{[\s\S]*\}|\[[\s\S]*\])[\s\S]*$/, "$1").trim();
    return JSON.parse(text);
  } catch (e) {
    try {
      return JSON.parse(String(str));
    } catch (e2) {
      return null;
    }
  }
}

// Modified from yichahucha / NobyDa — 精简适配层
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
    if (isNode) {
      const request = require("request");
      const fs = require("fs");
      const path = require("path");
      return { request, fs, path };
    }
    return null;
  })();

  const notify = (title, subtitle, message) => {
    console.log(`${title}\n${subtitle}\n${message}`);
    if (isQuanX) $notify(title, subtitle, message);
    if (isSurge) $notification.post(title, subtitle, message);
  };

  const write = (value, key) => {
    if (isQuanX) return $prefs.setValueForKey(value, key);
    if (isSurge) return $persistentStore.write(value, key);
    if (isNode) {
      try {
        const f = node.path.join(__dirname || ".", NodeSet);
        const data = node.fs.existsSync(f) ? JSON.parse(node.fs.readFileSync(f)) : {};
        data[key] = value;
        node.fs.writeFileSync(f, JSON.stringify(data));
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
        const f = node.path.join(__dirname || ".", NodeSet);
        if (!node.fs.existsSync(f)) return null;
        return JSON.parse(node.fs.readFileSync(f))[key];
      } catch (e) {
        return null;
      }
    }
  };

  const adapterStatus = (response) => {
    if (response) {
      if (response.status) response.statusCode = response.status;
      else if (response.statusCode) response.status = response.statusCode;
    }
    return response;
  };

  const fetch = (options, callback) => {
    if (!options.headers) options.headers = {};
    if (!options.headers["User-Agent"]) options.headers["User-Agent"] = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
    if (isQuanX) {
      if (typeof options == "string") options = { url: options };
      options.method = options.method || "GET";
      $task.fetch(options).then(
        (response) => {
          const payload = response && (response.body != null ? response.body : response.bodyBytes);
          callback(null, adapterStatus(response), payload);
        },
        (reason) => callback(reason.error, null, null)
      );
    }
    if (isSurge) {
      options.headers["X-Surge-Skip-Scripting"] = false;
      const fn = String(options.method || "GET").toUpperCase() === "POST" ? "post" : "get";
      $httpClient[fn](options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    }
    if (isNode) {
      if (options.body != null && typeof options.body !== "string") options.body = String(options.body);
      node.request(options, (error, response, body) => {
        // Node 的 request 默认不解压 gzip, 强制解压保证 JSON 可读
        if (body && Buffer.isBuffer(body)) {
          try {
            const zlib = require("zlib");
            const enc = String((response.headers && response.headers["content-encoding"]) || "").toLowerCase();
            if (enc.indexOf("gzip") >= 0) body = zlib.gunzipSync(body).toString();
            else if (enc.indexOf("deflate") >= 0) body = zlib.inflateSync(body).toString();
            else body = body.toString();
          } catch (e) {
            body = body.toString();
          }
        }
        callback(error, adapterStatus(response), body);
      });
    }
  };

  const AnError = (name, keyname, er, resp, body) => {
    if (typeof merge != "undefined" && keyname) {
      if (!merge[keyname]) merge[keyname] = {};
      merge[keyname].notify = `${name}: 异常, 已输出日志 ‼️`;
      merge[keyname].error = 1;
    }
    return console.log(
      `\n‼️${name}发生错误\n‼️名称: ${er.name}\n‼️描述: ${er.message}` +
        `${resp && resp.status ? `\n‼️状态: ${resp.status}` : ``}` +
        `${body ? `\n‼️响应: ${body}` : ``}`
    );
  };

  const time = () => {
    const end = ((Date.now() - start) / 1000).toFixed(2);
    return console.log("\n签到用时: " + end + " 秒");
  };

  const done = (value = {}) => {
    if (isQuanX) return $done(value || {});
    if (isSurge) return isRequest ? $done(value || {}) : $done();
    if (isLoon) return isRequest ? $done(value || {}) : $done();
  };

  return {
    AnError,
    isRequest,
    isSurge,
    isQuanX,
    isLoon,
    isNode,
    notify,
    write,
    read,
    fetch,
    time,
    done
  };
}
