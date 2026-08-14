/*************************

  比亚迪 App 每日签到脚本

  更新时间: 2026.08.14 (capture-v5-discover)
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
比亚迪_获取CK = type=http-request,pattern=^https:\/\/dilinkappserver(-cn)?\.byd\.auto\/.*(club|Sign\.signIn|integralMall),requires-body=1,max-size=0,script-path=https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js
比亚迪_每日签到 = type=cron,cronexp=10 8 * * *,wake-system=1,timeout=60,script-path=https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js

[MITM]
hostname = dilinkappserver-cn.byd.auto, dilinkappserver.byd.auto

【Quantumult X】
----------------
[rewrite_local]
^https:\/\/dilinkappserver(-cn)?\.byd\.auto\/.*(club|Sign\.signIn|integralMall) url script-request-body https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js

[task_local]
10 8 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js, tag=比亚迪签到, enabled=true

[mitm]
hostname = dilinkappserver-cn.byd.auto, dilinkappserver.byd.auto

【Loon】
----------------
[Script]
http-request ^https:\/\/dilinkappserver(-cn)?\.byd\.auto\/.*(club|Sign\.signIn|integralMall) script-path=https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js, requires-body=true, timeout=10, tag=比亚迪_获取CK
cron "10 8 * * *" script-path=https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js, tag=比亚迪_每日签到

[Mitm]
hostname = dilinkappserver-cn.byd.auto, dilinkappserver.byd.auto

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
      $nobyda.write("", "BYD_CaptureDiag");
      throw new Error("已清除比亚迪签到凭证/诊断，请重新打开 App 签到页抓取 ‼️");
    }

    if ($nobyda.isRequest) {
      GetCookie();
      return;
    }

    const cookies = ReadCookies();
    if (!cookies.length) {
      const tip = buildNoCookieTip();
      throw new Error(tip);
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

function isValidSignCookie(item) {
  if (!item || !item.request) return false;
  if (item._manual) return true;
  const url = String(item.url || "");
  const host = String(item.host || "");
  if (/vehicleRealTime|getStatusNow|query_configs|externalControl|external\/vehicle|cloud-app-api\/data|dilinksuper/i.test(url + host)) return false;
  if (item.signLike === true) return true;
  if (/Sign\.signIn|serviceDir=Sign|integralMall|\/club\//i.test(url)) return true;
  if (/dilinkappserver/i.test(host) && /\/club\//i.test(url) && item.request.length >= 64) return true;
  return false;
}

function ReadCookies() {
  const list = [];
  const multi = $nobyda.read("BYD_Cookies");
  const single = $nobyda.read("BYD_Cookie");

  const pushIf = (ck) => {
    if (ck && isValidSignCookie(ck)) list.push(ck);
    else if (ck) console.log("[BYD] 忽略非签到凭证: " + String(ck.url || ck.name || "").slice(0, 140));
  };

  if (multi) {
    try {
      const arr = JSON.parse(multi);
      if (Array.isArray(arr)) arr.forEach((item) => pushIf(normalizeCookie(item)));
    } catch (e) {
      console.log("BYD_Cookies 解析失败: " + e.message);
    }
  }

  if (single) {
    pushIf(normalizeCookie(single));
  }

  // 脚本内 OtherKey 手填
  if (OtherKey && String(OtherKey).trim()) {
    String(OtherKey)
      .split(/[\n&]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((raw) => {
        const ck = normalizeCookie(raw);
        if (ck) {
          ck._manual = true;
          list.push(ck);
        }
      });
  }

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

function buildNoCookieTip() {
  const diag = $nobyda.read("BYD_CaptureDiag") || "";
  let tip =
    "未获取到签到凭证 ‼️\n" +
    "当前没有可用 Sign/club 凭证（小组件车况 request 无效）。\n" +
    "请严格按下面步骤：\n" +
    "1) 重写资源强制更新到 capture-v5\n" +
    "2) MitM 开 HTTPS 解密并信任证书；hostname 含 dilinkappserver-cn.byd.auto、mina.byd.com\n" +
    "3) 策略 BYD 域名 DIRECT（保留 rewrite 解密）\n" +
    "4) 彻底杀进程后打开「比亚迪」主 App（非小组件）\n" +
    "5) 我的 → 每日签到 / 积分商城，点一次签到\n" +
    "6) 应出现「凭证新增/更新成功」；再跑定时任务\n" +
    "若打开签到页仍无新诊断：可能 App 对 dilink 证书固定，MitM 看不到包，把最新 [BYD capture] 日志发我";
  if (diag) {
    tip += "\n—— 最近抓包诊断 ——\n" + String(diag).slice(0, 700);
    if (/dilinksuper|vehicleRealTime|getStatusNow/i.test(diag) && !/dilinkappserver|\/club\/|Sign\.signIn|mina\.byd/i.test(diag)) {
      tip += "\n—— 解读 ——\n只有车况/小组件流量，没有主 App 签到流量。请进主 App 签到页；若仍无 dilinkappserver 诊断，优先怀疑证书固定/重写未生效。";
    }
  } else {
    tip += "\n—— 最近抓包诊断 ——\n无。说明 rewrite 完全未命中。请强制更新重写并确认 MitM hostname。";
  }
  return tip;
}

function GetCookie() {
  // 只读取 body/header 写本地凭证或诊断，不改请求；最后 $done({}) 原样放行
  try {
    const req = typeof $request !== "undefined" ? $request : null;
    if (!req || !req.url) {
      console.log("[BYD] GetCookie: 无 $request");
      $nobyda.done({});
      return;
    }

    const url = String(req.url || "");
    const hostRaw = (req.headers && (req.headers.Host || req.headers.host)) || extractHost(url) || "";
    const host = String(hostRaw).replace(/:\d+$/, "");
    const bodyText = typeof req.body === "string" ? req.body : (req.body ? String(req.body) : "");
    const method = req.method || "";
    const opType = (req.headers && (req.headers["Operation-Type"] || req.headers["operation-type"])) || "";

    const isMina = /mina\.byd\.com/i.test(host) || /\/mgw\.htm/i.test(url);
    const isVehicleNoise = /vehicleRealTime|getStatusNow|query_configs|externalControl|external\/vehicle|cloud-app-api\/data|dilinksuperappserver/i.test(url + " " + host);
    // 明确签到，或 dilinkappserver + /club/ （公开资料中的积分 club 网关）
    const isSignLike = /Sign\.signIn|serviceDir=Sign|integralMall|\/club\//i.test(url);
    const isAppServer = /dilinkappserver/i.test(host);
    const canTryStore = isSignLike || (isAppServer && !isVehicleNoise && !isMina);

    const diagLine =
      new Date().toISOString() +
      ` | ${method} | host=${host || "-"} | bodyLen=${bodyText.length} | signLike=${isSignLike ? 1 : 0} | app=${isAppServer ? 1 : 0}` +
      (opType ? ` | op=${String(opType).slice(0, 80)}` : "") +
      ` | url=${url.slice(0, 180)}`;
    console.log("[BYD capture] " + diagLine);
    appendDiag(diagLine);

    // mina 统一网关：多为 protobuf 加密，只能诊断
    if (isMina) {
      console.log("[BYD] mina 网关诊断: " + (opType || "(no Operation-Type)") + " — 不入库");
      $nobyda.done({});
      return;
    }

    // 车况/super：忽略
    if (isVehicleNoise || !canTryStore) {
      if (isVehicleNoise) console.log("[BYD] 忽略车况/控件请求（不能用于签到）");
      $nobyda.done({});
      return;
    }

    let requestVal = "";
    let bodyJson = null;

    if (bodyText) {
      const trimmed = bodyText.trim();
      try {
        bodyJson = JSON.parse(trimmed);
      } catch (e) {
        const m1 = bodyText.match(/(?:^|[&?])request=([^&]+)/i);
        if (m1) requestVal = decodeURIComponent(m1[1].replace(/\+/g, " "));
        if (!requestVal) {
          const m2 = bodyText.match(/"request"\s*:\s*"([^"]{32,})"/);
          if (m2) requestVal = m2[1];
        }
      }
    }

    if (bodyJson) {
      if (bodyJson.request) requestVal = String(bodyJson.request);
      else if (bodyJson.data && bodyJson.data.request) requestVal = String(bodyJson.data.request);
      else if (bodyJson.params && bodyJson.params.request) requestVal = String(bodyJson.params.request);
    }

    if (!requestVal && bodyText && /^[0-9A-Fa-f+/=]{64,}$/.test(bodyText.trim())) {
      requestVal = bodyText.trim();
    }

    if (!requestVal) {
      if (isSignLike) {
        const msg =
          "已命中签到相关 URL，但 body 无 request\n" +
          `url: ${url.slice(0, 200)}\n` +
          `bodyLen: ${bodyText.length}\n` +
          "请把该 URL 发我继续适配";
        console.log("[BYD] " + msg);
        $nobyda.notify("比亚迪抓包", "签到请求无 request", msg);
      }
      $nobyda.done({});
      return;
    }

    if (!isSignLike) {
      const msg =
        "命中 dilinkappserver 且含 request，但 URL 非 Sign/club\n" +
        `url: ${url.slice(0, 220)}\n` +
        `requestLen: ${requestVal.length}\n` +
        "若这是签到页发出的请求，把完整 URL 发我，我会放宽入库规则";
      console.log("[BYD] " + msg);
      $nobyda.notify("比亚迪抓包诊断", "未确认签到 URL", msg);
      $nobyda.done({});
      return;
    }

    const item = {
      request: requestVal,
      host: String(host || HOST).replace(/:\d+$/, ""),
      url: url,
      name: "签到页",
      headers: sanitizeHeaders(req.headers || {}),
      update: new Date().toISOString(),
      signLike: true
    };

    $nobyda.write(JSON.stringify(item), "BYD_Cookie");

    let list = [];
    try {
      list = JSON.parse($nobyda.read("BYD_Cookies") || "[]");
      if (!Array.isArray(list)) list = [];
    } catch (e) {
      list = [];
    }

    list = list
      .map((x) => normalizeCookie(x))
      .filter((x) => x && isValidSignCookie(x));

    const key = requestVal.slice(0, 32);
    let type = "新增";
    let found = false;
    list = list.map((old) => {
      if (old && (old.request || "").slice(0, 32) === key) {
        found = true;
        type = "更新";
        return item;
      }
      return old;
    });
    if (!found) list.unshift(item);
    list = list.slice(0, 10);
    $nobyda.write(JSON.stringify(list), "BYD_Cookies");
    $nobyda.write("", "BYD_CaptureDiag");

    const tip =
      `类型: ${type}\n` +
      `host: ${item.host}\n` +
      `url: ${url.slice(0, 160)}\n` +
      `request: ${requestVal.slice(0, 16)}...(${requestVal.length})\n` +
      "可手动运行「比亚迪签到」任务";
    console.log("\n比亚迪签到凭证" + type + "成功\n" + tip);
    $nobyda.notify("比亚迪签到凭证" + type + "成功", item.host, tip);
  } catch (e) {
    console.log("GetCookie 异常: " + (e.stack || e));
    $nobyda.notify("比亚迪抓包失败", "", String(e.message || e));
  }
  $nobyda.done({});
}


function appendDiag(line) {
  try {
    const old = $nobyda.read("BYD_CaptureDiag") || "";
    const lines = String(old)
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    lines.unshift(String(line));
    $nobyda.write(lines.slice(0, 8).join("\n"), "BYD_CaptureDiag");
  } catch (e) {}
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
    // request 阶段：空对象表示“不修改，直接放行”
    if (isQuanX) return $done(value || {})
    if (isSurge) return isRequest ? $done(value || {}) : $done()
    if (isLoon) return isRequest ? $done(value || {}) : $done()
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
