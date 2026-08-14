/*************************

  比亚迪 App 每日签到脚本

  更新时间: 2026.08.14
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  说明:
  1) 用户在比亚迪 App 内登录后，打开“积分商城/签到”页面（或点击一次签到）
  2) 本脚本通过 MitM 自动抓取签到请求中的加密 request 字段并持久化
  3) 定时任务自动复用该凭证完成签到

  注意:
  - 比亚迪签到 body 中的 request 为客户端加密载荷，随登录态变化
  - token/request 失效后需重新打开签到页抓取
  - 今日奖励通常为 1 积分（以服务端返回为准）

*************************

【推荐挂载 · Quantumult X】
----------------
重写引用:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/BYD_DailyBonus.conf

任务引用:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/BYD_DailyBonus.task

脚本本体:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js

地址说明:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/URLS.md

【Surge】
----------------
[Script]
比亚迪_获取CK = type=http-request,pattern=^https:\/\/dilink(super)?appserver(-cn)?\.byd\.auto\/.*Sign\.signIn,requires-body=1,max-size=0,script-path=https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js
比亚迪_每日签到 = type=cron,cronexp=10 8 * * *,wake-system=1,timeout=60,script-path=https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js

[MITM]
hostname = dilinkappserver-cn.byd.auto, dilinksuperappserver-cn.byd.auto, dilinkappserver.byd.auto

【Quantumult X】
----------------
[rewrite_local]
^https:\/\/dilink(super)?appserver(-cn)?\.byd\.auto\/.*Sign\.signIn url script-request-body https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js

[task_local]
10 8 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js, tag=比亚迪签到, enabled=true

[mitm]
hostname = dilinkappserver-cn.byd.auto, dilinksuperappserver-cn.byd.auto, dilinkappserver.byd.auto

【Loon】
----------------
[Script]
http-request ^https:\/\/dilink(super)?appserver(-cn)?\.byd\.auto\/.*Sign\.signIn script-path=https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js, requires-body=true, timeout=10, tag=比亚迪_获取CK
cron "10 8 * * *" script-path=https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js, tag=比亚迪_每日签到

[Mitm]
hostname = dilinkappserver-cn.byd.auto, dilinksuperappserver-cn.byd.auto, dilinkappserver.byd.auto

【Node.js】
----------------
1. 安装依赖: npm i request
2. 同目录创建 CookieSet.json（自动生成）
3. 或直接在脚本下方 OtherKey 中填写 request 密文

*************************/

var LogDetails = false; // 是否打印完整响应
var DeleteCookie = false; // true = 清除已保存凭证
var out = 0; // 超时(ms)，0 表示不强制超时
var Notify = true; // 是否推送通知

// Node/调试可直接填写；多账号用 & 或换行分隔
// 支持两种格式:
// 1) 纯 request 密文字符串
// 2) JSON: {"request":"...","host":"dilinkappserver-cn.byd.auto","url":"..."}
var OtherKey = ``;

var $nobyda = nobyda();
var merge = {};
var KEY = "";
var HOST = "dilinkappserver-cn.byd.auto";
var SIGN_PATH = "/club/?service=ForInterfaceApp.forward&serverFlag=integralMall&serviceDir=Sign.signIn";

var DefaultUA = "BYD/9.14.6 (iPhone; iOS 18.0; Scale/3.00)";

(async function Main() {
  try {
    if (DeleteCookie) {
      $nobyda.write("", "BYD_Cookie");
      $nobyda.write("", "BYD_Cookies");
      throw new Error("已清除比亚迪签到凭证，请重新打开 App 签到页抓取 ‼️");
    }

    if ($nobyda.isRequest) {
      GetCookie();
      return;
    }

    const cookies = ReadCookies();
    if (!cookies.length) {
      throw new Error("未获取到签到凭证，请先在代理工具开启 MitM，登录比亚迪 App 后打开签到页 ‼️");
    }

    for (let i = 0; i < cookies.length; i++) {
      await all(cookies[i], i + 1);
    }
  } catch (e) {
    $nobyda.notify("比亚迪签到", "", String(e.message || e));
    console.log("\n" + (e.stack || e));
  } finally {
    $nobyda.time();
    $nobyda.done();
  }
})();

function ReadCookies() {
  const list = [];
  const multi = $nobyda.read("BYD_Cookies");
  const single = $nobyda.read("BYD_Cookie") || OtherKey;

  if (multi) {
    try {
      const arr = JSON.parse(multi);
      if (Array.isArray(arr)) {
        arr.forEach((item) => {
          const ck = normalizeCookie(item);
          if (ck) list.push(ck);
        });
      }
    } catch (e) {
      console.log("BYD_Cookies 解析失败: " + e.message);
    }
  }

  if (!list.length && single) {
    String(single)
      .split(/[\n&]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((raw) => {
        const ck = normalizeCookie(raw);
        if (ck) list.push(ck);
      });
  }

  // 去重: request 前 32 位
  const seen = {};
  return list.filter((item) => {
    const k = (item.request || "").slice(0, 32);
    if (!k || seen[k]) return false;
    seen[k] = 1;
    return true;
  });
}

function normalizeCookie(input) {
  if (!input) return null;
  if (typeof input === "object") {
    if (!input.request) return null;
    return {
      request: String(input.request).trim(),
      host: (input.host || HOST).replace(/^https?:\/\//, "").replace(/\/$/, ""),
      url: input.url || "",
      name: input.name || "",
      headers: input.headers || null
    };
  }

  const text = String(input).trim();
  if (!text) return null;

  // 完整 JSON 字符串
  if (text[0] === "{") {
    try {
      return normalizeCookie(JSON.parse(text));
    } catch (e) {}
  }

  // 纯 request 密文
  return {
    request: text,
    host: HOST,
    url: "",
    name: "",
    headers: null
  };
}

async function all(cookieItem, index) {
  KEY = cookieItem.request;
  HOST = cookieItem.host || HOST;
  merge = {};

  await BYDSignIn(0, cookieItem);
  await notify(index, cookieItem);
}

function BYDSignIn(s, cookieItem) {
  merge.BYDSign = {};
  return new Promise((resolve) => {
    setTimeout(() => {
      const bodyObj = { request: KEY };
      const url = `https://${HOST}${SIGN_PATH}`;
      const headers = Object.assign(
        {
          Accept: "application/json",
          "Content-Type": "application/json; charset=UTF-8",
          "User-Agent": DefaultUA,
          Connection: "keep-alive"
        },
        pickUsefulHeaders(cookieItem.headers)
      );

      const options = {
        url,
        headers,
        body: JSON.stringify(bodyObj)
      };

      $nobyda.post(options, function (error, response, data) {
        try {
          if (error) throw new Error(error);
          const details = LogDetails ? "\nresponse:\n" + data : "";
          const cc = safeJSON(data);

          // 兼容多种返回结构
          // 1) 社区参考脚本: status==200 表示 ck 失效
          // 2) 常见成功: code/ret/status 为 0/"0"/200 且 message 成功
          // 3) 已签到文案识别
          const status = firstVal(cc, ["status", "code", "ret", "errCode", "errorCode"]);
          const msg = String(
            firstVal(cc, ["message", "msg", "errorMsg", "errorMessage", "retMsg", "desc"]) || ""
          );
          const reward = extractReward(cc);

          if (!cc) {
            merge.BYDSign.notify = "比亚迪签到: 失败, 响应非 JSON ‼️";
            merge.BYDSign.fail = 1;
            console.log("\n比亚迪签到失败, 响应非 JSON " + details);
          } else if (isInvalidToken(status, msg, data)) {
            merge.BYDSign.notify = "比亚迪签到: 失败, 原因: 凭证失效, 请重新打开签到页抓取 ‼️";
            merge.BYDSign.fail = 1;
            console.log("\n比亚迪签到失败, 凭证失效 " + details);
          } else if (isAlreadySigned(status, msg, data)) {
            merge.BYDSign.notify = "比亚迪签到: 失败, 原因: 今日已签过 ⚠️";
            merge.BYDSign.success = 1;
            merge.BYDSign.point = 0;
            console.log("\n比亚迪今日已签到 " + details);
          } else if (isSuccess(status, msg, cc)) {
            const p = reward != null ? reward : 1;
            merge.BYDSign.notify = `比亚迪签到: 成功, 明细: ${p}积分 🐶`;
            merge.BYDSign.success = 1;
            merge.BYDSign.point = Number(p) || 0;
            console.log("\n比亚迪签到成功 " + details);
          } else {
            merge.BYDSign.notify = `比亚迪签到: 失败, 原因: ${msg || "未知错误"} ⚠️`;
            merge.BYDSign.fail = 1;
            console.log("\n比亚迪签到失败 " + details);
            console.log(data);
          }
        } catch (eor) {
          $nobyda.AnError("比亚迪签到", "BYDSign", eor, response, data);
        } finally {
          resolve();
        }
      });
    }, s);
    if (out) setTimeout(resolve, out + s);
  });
}

function pickUsefulHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const allow = [
    "Cookie",
    "cookie",
    "Did",
    "did",
    "Authorization",
    "authorization",
    "token",
    "Token",
    "X-Token",
    "x-token",
    "User-Agent",
    "user-agent",
    "appChannel",
    "imeiMD5",
    "externalId"
  ];
  const outH = {};
  allow.forEach((k) => {
    if (headers[k] != null && headers[k] !== "") outH[k] = headers[k];
  });
  // 规范化 UA
  if (outH["user-agent"] && !outH["User-Agent"]) {
    outH["User-Agent"] = outH["user-agent"];
    delete outH["user-agent"];
  }
  return outH;
}

function extractReward(cc) {
  if (!cc || typeof cc !== "object") return null;
  const paths = [
    ["data"],
    ["data", "point"],
    ["data", "points"],
    ["data", "integral"],
    ["data", "score"],
    ["data", "reward"],
    ["data", "rewardPoint"],
    ["data", "signPoint"],
    ["data", "checkInCoupon"],
    ["point"],
    ["points"],
    ["integral"],
    ["score"],
    ["reward"],
    ["result", "point"],
    ["result", "integral"],
    ["body", "point"],
    ["body", "integral"]
  ];
  for (let i = 0; i < paths.length; i++) {
    const v = getPath(cc, paths[i]);
    if (v == null || v === "") continue;
    if (typeof v === "number" && !isNaN(v)) return v;
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  }
  // 从文案提取 “1积分”
  const text = JSON.stringify(cc);
  const m = text.match(/(\d+)\s*积分/) || text.match(/point[s]?[\"']?\s*[:=]\s*[\"']?(\d+)/i);
  return m ? Number(m[1]) : null;
}

function getPath(obj, path) {
  let cur = obj;
  for (let i = 0; i < path.length; i++) {
    if (cur == null) return null;
    cur = cur[path[i]];
  }
  return cur;
}

function firstVal(obj, keys) {
  if (!obj) return undefined;
  for (let i = 0; i < keys.length; i++) {
    if (obj[keys[i]] != null && obj[keys[i]] !== "") return obj[keys[i]];
  }
  // nested ret.error style
  if (obj.ret && typeof obj.ret === "object") {
    for (let i = 0; i < keys.length; i++) {
      if (obj.ret[keys[i]] != null && obj.ret[keys[i]] !== "") return obj.ret[keys[i]];
    }
  }
  return undefined;
}

function isInvalidToken(status, msg, raw) {
  const s = String(status);
  const m = (msg || "") + " " + String(raw || "");
  // 公开脚本约定: status == 200 表示 ck 失效
  if (s === "200" && /失效|过期|未登录|login|token|auth|credential|重新登录|无效/i.test(m)) return true;
  if (s === "200" && !/成功|success|已签|重复|complete/i.test(m) && /fail|error|invalid/i.test(m)) return true;
  if (/凭证失效|登录失效|未登录|重新登录|token.*invalid|auth.*fail|session.*expire|请重新登录/i.test(m)) return true;
  // 某些实现仅返回 status=200 且无成功语义
  if (s === "200" && !/成功|success|已签|重复|积分|point/i.test(m)) {
    // 保守: 仅当同时缺失 data 成功字段时，不直接判定失效
  }
  return false;
}

function isAlreadySigned(status, msg, raw) {
  const m = ((msg || "") + " " + String(raw || "")).toLowerCase();
  return /已签|重复签到|already|signed|今日已|已经签到|签到过/.test(m);
}

function isSuccess(status, msg, cc) {
  const s = String(status);
  const m = String(msg || "");
  if (/成功|success|ok|签到完成/i.test(m)) return true;
  if (s === "0" || s === "00" || s === "0000" || s === "10000") return true;
  // 与 byd.sh 相反语义: 非 200 的常见成功码
  if (s && s !== "200" && s !== "401" && s !== "403" && s !== "-1" && /成功|success|积分|point|data/i.test(JSON.stringify(cc))) {
    return true;
  }
  // 有明确奖励数字
  if (extractReward(cc) != null && !/失败|error|invalid/i.test(m)) return true;
  // ret.error == "0"
  if (cc && cc.ret && String(cc.ret.error) === "0") return true;
  return false;
}

async function notify(index, cookieItem) {
  const name = cookieItem.name || `账号${index}`;
  let success = 0;
  let fail = 0;
  let point = 0;
  let details = "";

  Object.keys(merge).forEach((k) => {
    const item = merge[k] || {};
    if (item.success) success += item.success;
    if (item.fail) fail += item.fail;
    if (item.error) fail += item.error;
    if (item.point) point += Number(item.point) || 0;
    if (item.notify) details += item.notify + "\n";
  });

  const title = "比亚迪签到";
  const subtitle = `${name}`;
  const body =
    `【签到概览】: 成功${success}个, 失败${fail}个\n` +
    `【签到奖励】: ${point}积分\n` +
    (details ? `【执行明细】:\n${details.trim()}\n` : "") +
    `【备注】: 奖励以服务端返回为准; 失效后请重抓 request`;

  console.log(`\n${title}\n${subtitle}\n${body}`);
  if (Notify) $nobyda.notify(title, subtitle, body);
}

function GetCookie() {
  try {
    const req = typeof $request !== "undefined" ? $request : null;
    if (!req || !req.url) throw new Error("无法读取请求对象");

    if (!/Sign\.signIn|serviceDir=Sign\.signIn|integralMall/i.test(req.url)) {
      $nobyda.done();
      return;
    }

    const host = (req.headers && (req.headers.Host || req.headers.host)) || extractHost(req.url) || HOST;
    const bodyText = req.body || "";
    let requestVal = "";
    let bodyJson = null;

    if (bodyText) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch (e) {
        // 可能是 x-www-form-urlencoded
        const m = bodyText.match(/(?:^|&)request=([^&]+)/);
        if (m) requestVal = decodeURIComponent(m[1]);
      }
    }

    if (bodyJson && bodyJson.request) requestVal = String(bodyJson.request);
    if (!requestVal && bodyText && /^[0-9A-Fa-f]{64,}$/.test(bodyText.trim())) {
      requestVal = bodyText.trim();
    }

    if (!requestVal) throw new Error("未在请求体中找到 request 字段");

    const item = {
      request: requestVal,
      host: String(host).replace(/:\d+$/, ""),
      url: req.url,
      name: "",
      headers: sanitizeHeaders(req.headers || {}),
      update: new Date().toISOString()
    };

    // 单账号键
    $nobyda.write(JSON.stringify(item), "BYD_Cookie");

    // 多账号列表: 按 request 前缀更新/新增
    let list = [];
    try {
      list = JSON.parse($nobyda.read("BYD_Cookies") || "[]");
      if (!Array.isArray(list)) list = [];
    } catch (e) {
      list = [];
    }

    const key = requestVal.slice(0, 32);
    let type = "新增";
    let found = false;
    list = list.map((old) => {
      const o = normalizeCookie(old);
      if (o && (o.request || "").slice(0, 32) === key) {
        found = true;
        type = "更新";
        return item;
      }
      return o || old;
    });
    if (!found) list.push(item);
    // 最多保留 10 个账号
    list = list.filter(Boolean).slice(-10);
    $nobyda.write(JSON.stringify(list), "BYD_Cookies");

    const tip = `比亚迪签到凭证${type}成功 🎉\nHost: ${item.host}\nrequest: ${requestVal.slice(0, 24)}...`;
    $nobyda.notify("比亚迪签到", "", tip);
    console.log("\n" + tip);
  } catch (e) {
    $nobyda.notify("比亚迪签到", "", "抓取凭证失败: " + (e.message || e) + " ‼️");
    console.log(e);
  } finally {
    $nobyda.done();
  }
}

function sanitizeHeaders(headers) {
  const h = {};
  Object.keys(headers || {}).forEach((k) => {
    // 跳过超大或无关头
    if (/^(Content-Length|Host|Connection|Accept-Encoding)$/i.test(k)) return;
    const v = headers[k];
    if (typeof v === "string" && v.length < 2000) h[k] = v;
  });
  return h;
}

function extractHost(url) {
  const m = String(url || "").match(/^https?:\/\/([^\/]+)/i);
  return m ? m[1] : "";
}

function safeJSON(str) {
  if (str == null) return null;
  if (typeof str === "object") return str;
  try {
    // 兼容部分代理工具 chunked 拼接残留
    const text = String(str)
      .replace(/^[\s\S]*?(\{[\s\S]*\}|\[[\s\S]*\])[\s\S]*$/, "$1")
      .trim();
    return JSON.parse(text);
  } catch (e) {
    try {
      return JSON.parse(String(str));
    } catch (e2) {
      return null;
    }
  }
}

// Modified from yichahucha / NobyDa
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

  const notify = (title, subtitle, message, rawopts) => {
    const Opts = (rawopts) => {
      if (!rawopts) return rawopts;
      if (typeof rawopts === "string") {
        if (isLoon) return rawopts;
        else if (isQuanX) return { "open-url": rawopts };
        else if (isSurge) return { url: rawopts };
        else return undefined;
      } else if (typeof rawopts === "object") {
        if (isLoon) {
          let openUrl = rawopts.openUrl || rawopts.url || rawopts["open-url"];
          let mediaUrl = rawopts.mediaUrl || rawopts["media-url"];
          return { openUrl, mediaUrl };
        } else if (isQuanX) {
          let openUrl = rawopts["open-url"] || rawopts.url || rawopts.openUrl;
          let mediaUrl = rawopts["media-url"] || rawopts.mediaUrl;
          return { "open-url": openUrl, "media-url": mediaUrl };
        } else if (isSurge) {
          let openUrl = rawopts.url || rawopts.openUrl || rawopts["open-url"];
          return { url: openUrl };
        }
      }
      return undefined;
    };
    console.log(`${title}\n${subtitle}\n${message}`);
    if (isQuanX) $notify(title, subtitle, message, Opts(rawopts));
    if (isSurge) $notification.post(title, subtitle, message, Opts(rawopts));
    if (isJSBox)
      $push.schedule({
        title: title,
        body: subtitle ? subtitle + "\n" + message : message
      });
  };

  const write = (value, key) => {
    if (isQuanX) return $prefs.setValueForKey(value, key);
    if (isSurge) return $persistentStore.write(value, key);
    if (isNode) {
      try {
        const file = node.path.resolve(__dirname, NodeSet);
        if (!node.fs.existsSync(file)) node.fs.writeFileSync(file, JSON.stringify({}));
        const dataValue = JSON.parse(node.fs.readFileSync(file));
        if (value) dataValue[key] = value;
        if (!value) delete dataValue[key];
        return node.fs.writeFileSync(file, JSON.stringify(dataValue));
      } catch (er) {
        return AnError("Node.js持久化写入", null, er);
      }
    }
    if (isJSBox) {
      if (!value) return $file.delete(`shared://${key}.txt`);
      return $file.write({
        data: $data({ string: value }),
        path: `shared://${key}.txt`
      });
    }
  };

  const read = (key) => {
    if (isQuanX) return $prefs.valueForKey(key);
    if (isSurge) return $persistentStore.read(key);
    if (isNode) {
      try {
        const file = node.path.resolve(__dirname, NodeSet);
        if (!node.fs.existsSync(file)) return null;
        const dataValue = JSON.parse(node.fs.readFileSync(file));
        return dataValue[key];
      } catch (er) {
        return AnError("Node.js持久化读取", null, er);
      }
    }
    if (isJSBox) {
      if (!$file.exists(`shared://${key}.txt`)) return null;
      return $file.read(`shared://${key}.txt`).string;
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
    if (!options.headers) options.headers = {};
    if (!options.headers["User-Agent"]) options.headers["User-Agent"] = DefaultUA;
    if (isQuanX) {
      if (typeof options == "string") options = { url: options };
      options["method"] = "GET";
      $task.fetch(options).then(
        (response) => callback(null, adapterStatus(response), response.body),
        (reason) => callback(reason.error, null, null)
      );
    }
    if (isSurge) {
      options.headers["X-Surge-Skip-Scripting"] = false;
      $httpClient.get(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    }
    if (isNode) {
      node.request(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    }
    if (isJSBox) {
      if (typeof options == "string") options = { url: options };
      options["header"] = options["headers"];
      options["handler"] = function (resp) {
        let error = resp.error;
        if (error) error = JSON.stringify(resp.error);
        let body = resp.data;
        if (typeof body == "object") body = JSON.stringify(resp.data);
        callback(error, adapterStatus(resp.response), body);
      };
      $http.get(options);
    }
  };

  const post = (options, callback) => {
    if (!options.headers) options.headers = {};
    if (!options.headers["User-Agent"]) options.headers["User-Agent"] = DefaultUA;
    // 允许调用方自定义 Content-Type；未设置时默认 JSON
    if (options.body && !options.headers["Content-Type"] && !options.headers["content-type"]) {
      options.headers["Content-Type"] = "application/json; charset=UTF-8";
    }
    if (isQuanX) {
      if (typeof options == "string") options = { url: options };
      options["method"] = "POST";
      $task.fetch(options).then(
        (response) => callback(null, adapterStatus(response), response.body),
        (reason) => callback(reason.error, null, null)
      );
    }
    if (isSurge) {
      options.headers["X-Surge-Skip-Scripting"] = false;
      $httpClient.post(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    }
    if (isNode) {
      node.request.post(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    }
    if (isJSBox) {
      if (typeof options == "string") options = { url: options };
      options["header"] = options["headers"];
      options["handler"] = function (resp) {
        let error = resp.error;
        if (error) error = JSON.stringify(resp.error);
        let body = resp.data;
        if (typeof body == "object") body = JSON.stringify(resp.data);
        callback(error, adapterStatus(resp.response), body);
      };
      $http.post(options);
    }
  };

  const AnError = (name, keyname, er, resp, body) => {
    if (typeof merge != "undefined" && keyname) {
      if (!merge[keyname]) merge[keyname] = {};
      if (!merge[keyname].notify) merge[keyname].notify = `${name}: 异常, 已输出日志 ‼️`;
      else merge[keyname].notify += `\n${name}: 异常, 已输出日志 ‼️ (2)`;
      merge[keyname].error = 1;
    }
    return console.log(
      `\n‼️${name}发生错误\n‼️名称: ${er.name}\n‼️描述: ${er.message}` +
        `${JSON.stringify(er).match(/\"line\"/) ? `\n‼️行列: ${JSON.stringify(er)}` : ``}` +
        `${resp && resp.status ? `\n‼️状态: ${resp.status}` : ``}` +
        `${body ? `\n‼️响应: ${resp && resp.status != 503 ? body : `Omit.`}` : ``}`
    );
  };

  const time = () => {
    const end = ((Date.now() - start) / 1000).toFixed(2);
    return console.log("\n签到用时: " + end + " 秒");
  };

  const done = (value = {}) => {
    if (isQuanX) return $done(value);
    if (isSurge) isRequest ? $done(value) : $done();
    if (isLoon) return $done(value);
  };

  return {
    AnError,
    isRequest,
    isJSBox,
    isSurge,
    isQuanX,
    isLoon,
    isNode,
    notify,
    write,
    read,
    get,
    post,
    time,
    done
  };
}
