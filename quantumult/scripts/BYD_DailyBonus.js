/*************************

  比亚迪 App 每日签到脚本

  更新时间: 2026.08.16 (capture-v9.1-open-home-cache)
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  说明:
  1) 目标：仅打开比亚迪 App（不必进签到页）即尝试自动签到
  2) 打开时首页 mina 流量（如 switches）作为“启动信号”，回放**已缓存**的签到包
  3) 首次/失效时需进一次签到页抓取 dynasty 凭证；进签到页后 App 本身常会自签
  4) 默认同日只尝试一次；定时任务可选

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
hostname = dilinkappserver-cn.byd.auto, dilinkappserver.byd.auto, mina.byd.com

【Quantumult X】
----------------
[rewrite_local]
^https:\/\/dilinkappserver(-cn)?\.byd\.auto\/.*(club|Sign\.signIn|integralMall) url script-request-body https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js

[task_local]
10 8 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js, tag=比亚迪签到, enabled=true

[mitm]
hostname = dilinkappserver-cn.byd.auto, dilinkappserver.byd.auto, mina.byd.com

【Loon】
----------------
[Script]
http-request ^https:\/\/dilinkappserver(-cn)?\.byd\.auto\/.*(club|Sign\.signIn|integralMall) script-path=https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js, requires-body=true, timeout=10, tag=比亚迪_获取CK
cron "10 8 * * *" script-path=https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js, tag=比亚迪_每日签到

[Mitm]
hostname = dilinkappserver-cn.byd.auto, dilinkappserver.byd.auto, mina.byd.com

【Node.js】
----------------
1. 安装依赖: npm i request
2. 同目录创建 CookieSet.json（自动生成）
3. 或直接在脚本下方 OtherKey 中填写 request 密文

*************************/

var LogDetails = false; // 是否打印完整响应
var DeleteCookie = false; // true = 清除已保存凭证
// true = 把「最近一次 mina 请求」标记为签到凭证（点完签到后立刻手动跑一次脚本）
var MarkMinaAsSign = false;
// true = 签到时只回放 mina 网关请求（默认自动识别 type=mina）
var PreferMinaReplay = true;
// true = 抓到 dynasty.srv 时自动暂存为签到凭证（进页/点签都会更新；降低每天手动 Mark 成本）
var AutoPromoteMina = true;
// 自动暂存时是否弹通知（默认否，避免刷屏；标记结果仍写日志）
var AutoPromoteNotify = false;
// true = 打开 App（首页 mina 启动信号）时异步触发一次签到（主模式）
var SignOnAppOpen = true;
// true = 允许用“首页启动信号 + 缓存凭证”签到，不必进签到页
var SignOnHomeOpen = true;
// true = 自然日成功/明确完成后不再自动签（防一天内刷屏回放）
var OpenAppSignOncePerDay = true;
// 同一时段多条 dynasty 包的去抖（秒）
var OpenAppSignDebounceSec = 120;
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
      $nobyda.write("", "BYD_MinaLast");
      $nobyda.write("", "BYD_MinaSign");
      $nobyda.write("", "BYD_MinaRing");
      $nobyda.write("", "BYD_OpenAppSignDate");
      $nobyda.write("", "BYD_OpenAppSignLock");
      $nobyda.write("", "BYD_OpenAppPendingAt");
      $nobyda.write("", "BYD_OpenAppFiredAt");
      $nobyda.write("", "BYD_LastReplay");
      throw new Error("已清除比亚迪签到凭证/诊断，请重新打开 App 签到页抓取 ‼️");
    }

    if ($nobyda.isRequest) {
      GetCookie();
      return;
    }

    // 点完 App「签到」后立刻跑一次：把最近 mina 请求标记为签到凭证
    if (MarkMinaAsSign) {
      const marked = markLastMinaAsSign();
      throw new Error(marked);
    }

    let cookies = ReadCookies();
    if (!cookies.length) {
      // 兜底：环形缓冲里可能已有今日点签/进页抓到的 dynasty.srv，但用户没 Mark
      const promoted = promoteBestMinaToCookie(false);
      if (promoted) {
        console.log("[BYD] 无本地凭证，已从 mina 缓冲自动提升: " + promoted);
        cookies = ReadCookies();
      }
    }
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
    // request 入口由 GetCookie 负责 $done，避免重复 done 打断异步签到
    if (!$nobyda.isRequest) {
      $nobyda.time();
      $nobyda.done();
    }
  }
})();

function isValidSignCookie(item) {
  if (!item) return false;
  // mina 网关回放凭证
  if (item.type === "mina" && item.url && (item.body || item.bodyB64)) return true;
  if (!item.request) return false;
  if (item._manual) return true;
  const url = String(item.url || "");
  const host = String(item.host || "");
  if (/vehicleRealTime|getStatusNow|query_configs|externalControl|external\/vehicle|cloud-app-api\/data/i.test(url)) return false;
  if (/superappserver/i.test(host)) return false;
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
    if (input.type === "mina" && input.url && (input.body || input.bodyB64)) {
      const bodyKey = input.bodyB64 || String(input.body || "");
      return {
        type: "mina",
        request: String(bodyKey).slice(0, 64), // 去重 key
        body: input.body || "",
        bodyB64: input.bodyB64 || "",
        bodyLen: input.bodyLen || 0,
        bodyHex: input.bodyHex || "",
        host: (input.host || "mina.byd.com").replace(/^https?:\/\//, "").replace(/\/$/, ""),
        url: input.url,
        name: input.name || "mina签到",
        headers: input.headers || null,
        opType: input.opType || "",
        productId: input.productId || "",
        update: input.update || "",
        signLike: true,
        _manual: !!input._manual
      };
    }
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
      let options;
      if ((PreferMinaReplay && cookieItem && cookieItem.type === "mina") || (cookieItem && cookieItem.type === "mina")) {
        // 回放 mPaaS 网关：尽量原样 headers + bodyBytes(base64)
        const h = Object.assign({}, cookieItem.headers || {});
        Object.keys(h).forEach((k) => {
          if (/^(Content-Length|Host|Connection|Accept-Encoding)$/i.test(k)) delete h[k];
        });
        options = {
          url: cookieItem.url || `https://${cookieItem.host || "mina.byd.com"}:31801/mgw.htm`,
          headers: h
        };
        // 优先 bodyBytes（避免二进制经 string 损坏）
        if (cookieItem.bodyB64) {
          const ab = b64ToArrayBuffer(cookieItem.bodyB64);
          if (ab) {
            options.bodyBytes = ab;
          } else {
            options.body = cookieItem.body || "";
          }
        } else {
          options.body = cookieItem.body || "";
        }
        console.log(
          "[BYD] mina 回放: op=" +
            (cookieItem.opType || "-") +
            " bodyLen=" +
            (cookieItem.bodyLen || String(cookieItem.body || "").length) +
            " hasB64=" +
            (cookieItem.bodyB64 ? 1 : 0)
        );
      } else {
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
        options = {
          url,
          headers,
          body: JSON.stringify(bodyObj)
        };
      }

      $nobyda.post(options, function (error, response, data) {
        try {
          if (error) throw new Error(error);
          const isMina = cookieItem && cookieItem.type === "mina";
          const httpStatus = response && (response.statusCode || response.status);
          let respHex = "";
          let respLen = 0;
          if (response && response.bodyBytes) {
            try {
              respHex = arrayBufferToHex(response.bodyBytes, 24);
              respLen = response.bodyBytes.byteLength != null ? response.bodyBytes.byteLength : (response.bodyBytes.length || 0);
            } catch (e) {
              respHex = toHexPreview(data, 24);
              respLen = data == null ? 0 : String(data).length;
            }
          } else {
            respHex = toHexPreview(data, 24);
            respLen = data == null ? 0 : String(data).length;
          }
          const details =
            (LogDetails || isMina
              ? "\nhttp=" +
                (httpStatus == null ? "-" : httpStatus) +
                " respLen=" +
                respLen +
                " respHex=" +
                respHex +
                "\nresponseHead:\n" +
                String(data == null ? "" : data).slice(0, 240)
              : "");
          console.log("[BYD] response meta: http=" + (httpStatus == null ? "-" : httpStatus) + " len=" + respLen + " hex=" + respHex);

          // 保存最近一次回放响应，方便你复制发我
          try {
            $nobyda.write(
              JSON.stringify({
                at: new Date().toISOString(),
                http: httpStatus,
                len: respLen,
                hex: respHex,
                head: String(data == null ? "" : data).slice(0, 400),
                mina: !!isMina
              }),
              "BYD_LastReplay"
            );
          } catch (e) {}

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
            // mina/mPaaS 响应通常是二进制，不一定是失败
            if (isMina) {
              if (httpStatus && Number(httpStatus) >= 200 && Number(httpStatus) < 300 && respLen > 0) {
                merge.BYDSign.notify =
                  "比亚迪签到: mina回放已送达(HTTP " +
                  httpStatus +
                  "), 但响应为二进制无法自动判定成功/失败 ⚠️\n" +
                  "respHex=" +
                  respHex +
                  " len=" +
                  respLen +
                  "\n请把本通知发我，并确认 App 积分是否变化";
                // 不直接记 success，避免误报；记 fail 便于你继续迭代，同时附带元数据
                merge.BYDSign.fail = 1;
                merge.BYDSign.meta = "mina-binary-resp";
                console.log("\n比亚迪 mina 回放响应为二进制 " + details);
              } else {
                merge.BYDSign.notify =
                  "比亚迪签到: mina回放失败, HTTP=" +
                  (httpStatus == null ? "-" : httpStatus) +
                  ", respLen=" +
                  respLen +
                  " ‼️\nrespHex=" +
                  respHex;
                merge.BYDSign.fail = 1;
                console.log("\n比亚迪 mina 回放失败 " + details);
              }
            } else {
              merge.BYDSign.notify = "比亚迪签到: 失败, 响应非 JSON ‼️";
              merge.BYDSign.fail = 1;
              console.log("\n比亚迪签到失败, 响应非 JSON " + details);
            }
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
    "当前没有可用签到凭证（仅有 mina 抓包不够；需手动标记后才有回放凭证）。\n" +
    "请严格按下面步骤（capture-v9 打开App触发）：\n" +
    "1) 重写资源强制更新到 capture-v9（打开 App 自动签到）\n" +
    "2) MitM 开 HTTPS 解密并信任证书；hostname 含 dilinkappserver-cn.byd.auto、mina.byd.com\n" +
    "3) 策略 BYD 域名 DIRECT（保留 rewrite 解密）\n" +
    "4) 彻底杀进程后打开「比亚迪」主 App（非小组件）\n" +
    "5) 我的 → 每日签到，点一次真实签到（今天若按钮灰掉仅能进页，则等可点时再做）\n" +
    "6) 立刻将脚本 MarkMinaAsSign=true 跑一次；通知应有 hasB64:1 与 capturedAt\n" +
    "7) 立刻改回 MarkMinaAsSign=false，再手动运行任务回放\n" +
    "说明：出现 [BYD mina] 只代表抓到了网关包，不会自动当签到凭证；开关类 op（switches/getUnionResource）无效";
  if (diag) {
    tip += "\n—— 最近抓包诊断 ——\n" + String(diag).slice(0, 700);
    if (/vehicleRealTime|getStatusNow|superappserver/i.test(diag) && !/dilinkappserver|\/club\/|Sign\.signIn|mina\.byd/i.test(diag)) {
      tip += "\n—— 解读 ——\n只有车况/小组件流量，没有主 App 签到流量。请进主 App 签到页；若仍无 dilinkappserver 诊断，优先怀疑证书固定/重写未生效。";
    } else if (/switches\.all|getUnionResource|afterloginPb/i.test(diag) && !/com\.app\.dynasty\.srv/i.test(diag)) {
      tip += "\n—— 解读 ——\n最近诊断只有首页/开关类 mina 包，没有 dynasty.srv。请进入「每日签到」页并点签到后再 MarkMinaAsSign。";
    } else if (/com\.app\.dynasty\.srv/i.test(diag)) {
      tip += "\n—— 解读 ——\n已抓到 dynasty.srv，但尚未标记为签到凭证。点完签到后立刻 MarkMinaAsSign=true 跑一次，确认 hasB64:1。";
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
    const isVehicleNoise = /vehicleRealTime|getStatusNow|query_configs|externalControl|external\/vehicle|cloud-app-api\/data/i.test(url) || /superappserver/i.test(host);
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

    // mina / mPaaS 统一网关：body 全加密，op 常固定为 com.app.dynasty.srv
    // 策略：环形缓冲最近请求 + 用户点完签到后 MarkMinaAsSign 标记回放
    if (isMina) {
      const h = req.headers || {};
      const pick = (keys) => {
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (h[k] != null && h[k] !== "") return String(h[k]);
          const hit = Object.keys(h).find((x) => x.toLowerCase() === k.toLowerCase());
          if (hit && h[hit] != null && h[hit] !== "") return String(h[hit]);
        }
        return "";
      };

      const apiName = pick(["Api", "api", "Operation-Type", "operation-type", "RpcId", "rpcId", "OperationType"]);
      const productId = pick(["productId", "ProductId", "AppId", "appId"]);
      const workspaceId = pick(["WorkspaceId", "workspaceId"]);
      const sign = pick(["Sign", "sign"]);
      const did = pick(["Did", "did"]);
      const uuid = pick(["uuid", "UUID"]);
      const contentType = pick(["Content-Type", "content-type"]);
      const ts = pick(["Ts", "ts", "tsValue"]);
      const mpassVersion = pick(["mpassVersion", "mpaasVersion", "Version"]);
      const platform = pick(["Platform", "platform"]);
      const headerKeys = Object.keys(h).join(",");
      const bodyHex = toHexPreview(bodyText, 24);

      const rawBody = getRawRequestBody(req);
      const bodyB64 = rawBody.b64 || "";
      const bodyForStore = rawBody.text != null ? rawBody.text : bodyText;
      const bodyLenReal = rawBody.len != null ? rawBody.len : bodyText.length;
      const bodyHexReal = rawBody.hex || bodyHex;

      const minaSnap = {
        type: "mina",
        host,
        url,
        method,
        opType: opType || apiName || "",
        productId,
        workspaceId,
        sign,
        did,
        uuid,
        ts,
        mpassVersion,
        platform,
        contentType,
        headerKeys,
        headers: sanitizeHeaders(h),
        body: bodyForStore,
        bodyB64: bodyB64,
        bodyLen: bodyLenReal,
        bodyHex: bodyHexReal,
        bodySource: rawBody.source || "text",
        update: new Date().toISOString()
      };

      // 环形缓冲：最近 12 条（按 bodyLen+hex 去重）
      pushMinaRing(minaSnap);
      $nobyda.write(JSON.stringify(compactMina(minaSnap)), "BYD_MinaLast");

      const diagMina =
        new Date().toISOString() +
        ` | MINA | op=${(minaSnap.opType || "-").slice(0, 80)} | product=${(productId || "-").slice(0, 28)}` +
        ` | bodyLen=${minaSnap.bodyLen} | hex=${minaSnap.bodyHex} | src=${minaSnap.bodySource}` +
        ` | keys=${headerKeys.slice(0, 120)}`;
      console.log("[BYD mina] " + diagMina);
      appendDiag(diagMina);

      // 业务 RPC 自动暂存为签到凭证（排除 switches 等噪音）
      if (AutoPromoteMina) {
        try {
          autoPromoteMinaIfEligible(minaSnap);
        } catch (e) {
          console.log("[BYD] autoPromote err: " + e);
        }
      }

      // 仅低频提示，避免首页刷屏
      maybeNotifyMinaHint(minaSnap);

      // 主模式：打开 App = 首页 mina 启动信号 → 回放缓存签到包（不必进签到页）
      // dynasty.srv：用于刷新缓存凭证；switches/afterlogin：仅作打开信号
      if (SignOnAppOpen) {
        try {
          if (isPromotableMina(minaSnap)) {
            // 进签到页才会出现：刷新 CK；若 App 已自签，脚本同日也只尝试一次
            scheduleOpenAppSign(minaSnap, "capture");
          } else if (SignOnHomeOpen && isHomeOpenSignal(minaSnap)) {
            scheduleOpenAppSign(minaSnap, "home");
          }
        } catch (e) {
          console.log("[BYD] openAppSign schedule err: " + e);
        }
      }
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




function getRawRequestBody(req) {
  // 优先 bodyBytes，避免二进制经 UTF-8 string 损坏（hex 里大量 fd 就是损坏迹象）
  try {
    if (req && req.bodyBytes) {
      const b64 = arrayBufferToB64(req.bodyBytes);
      const hex = arrayBufferToHex(req.bodyBytes, 24);
      const len = req.bodyBytes.byteLength != null ? req.bodyBytes.byteLength : (req.bodyBytes.length || 0);
      return { source: "bodyBytes", b64: b64, hex: hex, len: len, text: "" };
    }
  } catch (e) {}
  const t = typeof req.body === "string" ? req.body : (req.body ? String(req.body) : "");
  return {
    source: "text",
    b64: textToB64(t),
    hex: toHexPreview(t, 24),
    len: t.length,
    text: t
  };
}

function pickBestMinaCandidate() {
  let ring = [];
  try {
    ring = JSON.parse($nobyda.read("BYD_MinaRing") || "[]");
    if (!Array.isArray(ring)) ring = [];
  } catch (e) {
    ring = [];
  }
  let last = null;
  try {
    last = JSON.parse($nobyda.read("BYD_MinaLast") || "null");
  } catch (e) {
    last = null;
  }

  // 合并去重：优先保留 update 较新的条目
  const map = {};
  const pushOne = (x) => {
    if (!x || !x.url || !(x.body || x.bodyB64)) return;
    const op = String(x.opType || "");
    // 排除配置开关/资源类 RPC（进首页噪音）
    if (/switches\.all\.get|afterloginPb|alipay\.client\.switches|getUnionResource/i.test(op)) return;
    const key = (x.bodyHex || "") + ":" + (x.bodyLen || 0) + ":" + String(x.bodyB64 || "").slice(0, 24);
    const old = map[key];
    if (!old) {
      map[key] = x;
      return;
    }
    const ot = Date.parse(old.update || 0) || 0;
    const nt = Date.parse(x.update || 0) || 0;
    if (nt >= ot) map[key] = x;
  };
  ring.forEach(pushOne);
  pushOne(last);

  const usable = Object.keys(map).map((k) => map[k]);

  // 点完签到后立刻 Mark：取「最新」dynasty.srv，而不是 body 最大
  // 进签到页往往会先发较大 body 的查询包；真正签到包通常更靠后
  usable.sort((a, b) => {
    const sa = /com\.app\.dynasty\.srv/i.test(String(a.opType || "")) ? 1 : 0;
    const sb = /com\.app\.dynasty\.srv/i.test(String(b.opType || "")) ? 1 : 0;
    if (sa !== sb) return sb - sa;
    const ta = Date.parse(a.update || 0) || 0;
    const tb = Date.parse(b.update || 0) || 0;
    if (ta !== tb) return tb - ta;
    const ba = a.bodyB64 ? 1 : 0;
    const bb = b.bodyB64 ? 1 : 0;
    if (ba !== bb) return bb - ba;
    return (Number(b.bodyLen) || 0) - (Number(a.bodyLen) || 0);
  });
  return usable[0] || last || ring[0] || null;
}

function arrayBufferToB64(buf) {
  try {
    const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
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
  } catch (e) {
    return "";
  }
}

function arrayBufferToHex(buf, n) {
  try {
    const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
    const max = Math.min(u8.length, n || 16);
    let out = "";
    for (let i = 0; i < max; i++) {
      const c = u8[i];
      out += (c < 16 ? "0" : "") + c.toString(16);
    }
    return out;
  } catch (e) {
    return "";
  }
}

function textToB64(str) {
  try {
    const s = String(str || "");
    // latin1 方式编码任意 0-255 字符
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
    return arrayBufferToB64(u8.buffer);
  } catch (e) {
    return "";
  }
}

function b64ToArrayBuffer(b64) {
  try {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let str = String(b64 || "").replace(/[^A-Za-z0-9\+\/]/g, "");
    const len = str.length;
    if (!len) return null;
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
    return u8.buffer;
  } catch (e) {
    return null;
  }
}

function compactMina(snap) {
  // 持久化时保留回放必需字段
  return {
    type: "mina",
    host: snap.host,
    url: snap.url,
    method: snap.method,
    opType: snap.opType,
    productId: snap.productId,
    headers: snap.headers,
    body: snap.body,
    bodyB64: snap.bodyB64 || "",
    bodyLen: snap.bodyLen,
    bodyHex: snap.bodyHex,
    bodySource: snap.bodySource || "",
    headerKeys: snap.headerKeys,
    update: snap.update
  };
}

function toHexPreview(str, n) {
  try {
    const s = String(str || "");
    let out = "";
    const max = Math.min(s.length, n || 16);
    for (let i = 0; i < max; i++) {
      const c = s.charCodeAt(i) & 0xff;
      out += (c < 16 ? "0" : "") + c.toString(16);
    }
    return out;
  } catch (e) {
    return "";
  }
}

function pushMinaRing(snap) {
  try {
    let arr = [];
    try {
      arr = JSON.parse($nobyda.read("BYD_MinaRing") || "[]");
      if (!Array.isArray(arr)) arr = [];
    } catch (e) {
      arr = [];
    }
    const item = compactMina(snap);
    // 去重：相同 bodyLen+hex 只更新时间
    const key = (item.bodyLen || 0) + ":" + (item.bodyHex || "");
    let found = false;
    arr = arr.map((x) => {
      const k = (x.bodyLen || 0) + ":" + (x.bodyHex || "");
      if (k === key) {
        found = true;
        return item;
      }
      return x;
    });
    if (!found) arr.unshift(item);
    $nobyda.write(JSON.stringify(arr.slice(0, 12)), "BYD_MinaRing");
  } catch (e) {}
}

function maybeNotifyMinaHint(snap) {
  try {
    const now = Date.now();
    const last = Number($nobyda.read("BYD_MinaHintAt") || 0);
    if (now - last < 60000) return; // 60s 节流
    $nobyda.write(String(now), "BYD_MinaHintAt");
    const tip =
      "已抓到 mina 加密网关包（op 固定、body 加密属正常）\n" +
      `最近 bodyLen=${snap.bodyLen}\n` +
      "请：打开签到页并点一次签到 → 脚本设 MarkMinaAsSign=true 再跑一次标记 → 改回 false 后定时签到\n" +
      "也可把此刻 QX 日志中 [BYD mina] 的 hex/bodyLen 发我";
    if (Notify) $nobyda.notify("比亚迪 mina 抓包中", "等你点签到后标记", tip);
  } catch (e) {}
}



function dayKeyLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function canTriggerOpenAppSign() {
  if (!SignOnAppOpen) return false;
  if (OpenAppSignOncePerDay) {
    const doneDay = $nobyda.read("BYD_OpenAppSignDate") || "";
    if (doneDay === dayKeyLocal()) {
      console.log("[BYD openSign] skip: already done today " + doneDay);
      return false;
    }
  }
  return true;
}

function markOpenAppSignLock() {
  $nobyda.write(String(Date.now()), "BYD_OpenAppSignLock");
}

function markOpenAppSignDayDone() {
  $nobyda.write(dayKeyLocal(), "BYD_OpenAppSignDate");
}

// 打开 App 首页常见 mina op（不是签到 body，只当启动信号）
function isHomeOpenSignal(snap) {
  if (!snap) return false;
  const op = String(snap.opType || "");
  return /switches\.all\.get|afterloginPb|alipay\.client\.switches|getUnionResource/i.test(op);
}

// 解析真正用于回放的签到凭证：优先缓存，不以首页 switches body 当签到包
function resolveOpenAppSignItem() {
  const tryParse = (raw) => {
    if (!raw) return null;
    try {
      return normalizeCookie(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  };

  let item = tryParse($nobyda.read("BYD_MinaSign"));
  if (item && isValidSignCookie(item) && item.type === "mina") return item;

  item = tryParse($nobyda.read("BYD_Cookie"));
  if (item && isValidSignCookie(item) && item.type === "mina") return item;

  try {
    const list = JSON.parse($nobyda.read("BYD_Cookies") || "[]");
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        const ck = normalizeCookie(list[i]);
        if (ck && ck.type === "mina" && isValidSignCookie(ck)) return ck;
      }
    }
  } catch (e) {}

  // 环缓里最新 dynasty（可能刚在签到页抓到）
  const best = pickBestMinaCandidate();
  if (isPromotableMina(best)) {
    const ck = normalizeCookie(
      Object.assign({}, best, {
        type: "mina",
        name: "mina缓冲",
        signLike: true
      })
    );
    if (ck) return ck;
  }
  return null;
}

// mode: "home" | "capture"
// home = 打开首页信号，只回放缓存，不把当前 snap 当签到 body
// capture = 抓到 dynasty，先刷新缓存，再回放
function scheduleOpenAppSign(snap, mode) {
  mode = mode || "home";

  // 抓到 dynasty 时始终刷新缓存（即便今日已签/已尝试）
  if (mode === "capture" && isPromotableMina(snap)) {
    try {
      promoteMinaSnap(snap, { name: "mina签到凭证", notify: false, manual: false });
    } catch (e) {}
  }

  // 今日已完成则不再回放
  if (!canTriggerOpenAppSign()) return;

  const now = Date.now();
  $nobyda.write(String(now), "BYD_OpenAppPendingAt");
  $nobyda.write(String(mode || "home"), "BYD_OpenAppPendingMode");
  console.log(
    "[BYD openSign] pending mode=" +
      mode +
      " signalOp=" +
      ((snap && snap.opType) || "-") +
      " at=" +
      now
  );

  // 首页 switches 通常很快结束；1.2s 够；capture 连发 dynasty 用 1.8s
  const collectMs = mode === "capture" ? 1800 : 1200;
  const myPending = now;

  const attemptFire = () => {
    try {
      if (!canTriggerOpenAppSign()) return;
      const pendingAt = Number($nobyda.read("BYD_OpenAppPendingAt") || 0);
      if (pendingAt > myPending) {
        console.log("[BYD openSign] newer signal, yield");
        return;
      }
      if (Date.now() - pendingAt < collectMs - 50) {
        console.log("[BYD openSign] still collecting");
        return;
      }

      const item = resolveOpenAppSignItem();
      if (!item) {
        console.log("[BYD openSign] no cached sign cookie");
        if (Notify) {
          $nobyda.notify(
            "比亚迪打开App签到",
            "缺少签到凭证",
            "打开首页已检测到，但本地还没有可回放的签到包。\n请「一次性」进入：我的 → 每日签到（让 App 自签即可），脚本会缓存 dynasty 凭证；\n之后一般只需打开 App，无需再进签到页。\n若长期只开首页从不进签到页，将无法建立首次凭证。"
          );
        }
        // 不记 day done，便于用户进页抓到后再触发
        return;
      }

      const firedKey = dayKeyLocal() + ":" + String(pendingAt);
      if ($nobyda.read("BYD_OpenAppFiredAt") === firedKey) {
        console.log("[BYD openSign] already fired this burst");
        return;
      }
      $nobyda.write(firedKey, "BYD_OpenAppFiredAt");
      markOpenAppSignLock();
      triggerOpenAppSign(item);
    } catch (e) {
      console.log("[BYD openSign] attemptFire err: " + e);
    }
  };

  if (typeof setTimeout !== "undefined") setTimeout(attemptFire, collectMs);
  else attemptFire();
}

function triggerOpenAppSign(itemOrSnap) {
  const item =
    itemOrSnap && itemOrSnap.type === "mina" && itemOrSnap.bodyB64
      ? itemOrSnap
      : normalizeCookie(
          Object.assign({}, itemOrSnap || {}, {
            type: "mina",
            name: (itemOrSnap && itemOrSnap.name) || "打开App自动签到",
            signLike: true,
            _manual: false
          })
        );
  if (!item || !isValidSignCookie(item)) {
    console.log("[BYD openSign] invalid item");
    return;
  }

  console.log(
    "[BYD openSign] fire op=" +
      (item.opType || "-") +
      " bodyLen=" +
      (item.bodyLen || 0) +
      " hasB64=" +
      (item.bodyB64 ? 1 : 0) +
      " name=" +
      (item.name || "-")
  );

  const run = () => {
    merge = {};
    KEY = item.request;
    HOST = item.host || HOST;
    BYDSignIn(0, item)
      .then(() => {
        const st = merge.BYDSign || {};
        markOpenAppSignDayDone();
        const title = "比亚迪打开App签到";
        const msg = st.notify || "无明细";
        console.log("[BYD openSign] result: " + msg);
        if (Notify) $nobyda.notify(title, item.name || "缓存回放", msg);
      })
      .catch((e) => {
        console.log("[BYD openSign] exception: " + e);
        markOpenAppSignDayDone();
        if (Notify) $nobyda.notify("比亚迪打开App签到", "异常", String(e.message || e));
      });
  };

  if (typeof setTimeout !== "undefined") setTimeout(run, 200);
  else run();
}

function isPromotableMina(snap) {
  if (!snap || !snap.url || !(snap.body || snap.bodyB64)) return false;
  const op = String(snap.opType || "");
  if (/switches\.all\.get|afterloginPb|alipay\.client\.switches|getUnionResource/i.test(op)) return false;
  // 目前用户环境业务 RPC 统一是 dynasty.srv；保留扩展点
  if (!/com\.app\.dynasty\.srv/i.test(op)) return false;
  // 有 b64 更可靠；text 也可暂存但效果可能差
  return true;
}

function autoPromoteMinaIfEligible(snap) {
  if (!isPromotableMina(snap)) return false;
  const msg = promoteMinaSnap(snap, {
    name: "mina自动暂存",
    notify: !!AutoPromoteNotify,
    manual: false
  });
  if (msg) console.log("[BYD autoPromote] " + msg.replace(/\n/g, " | "));
  return !!msg;
}

function promoteBestMinaToCookie(fromMark) {
  const best = pickBestMinaCandidate();
  if (!isPromotableMina(best)) return "";
  return promoteMinaSnap(best, {
    name: fromMark ? "mina签到(手动标记)" : "mina缓冲自动提升",
    notify: false,
    manual: !!fromMark
  });
}

function promoteMinaSnap(snap, opts) {
  opts = opts || {};
  const item = normalizeCookie(
    Object.assign({}, snap, {
      type: "mina",
      name: opts.name || "mina签到",
      signLike: true,
      _manual: !!opts.manual
    })
  );
  if (!item) return "";
  $nobyda.write(JSON.stringify(item), "BYD_Cookie");
  $nobyda.write(JSON.stringify(item), "BYD_MinaSign");
  let list = [];
  try {
    list = JSON.parse($nobyda.read("BYD_Cookies") || "[]");
    if (!Array.isArray(list)) list = [];
  } catch (e) {
    list = [];
  }
  list = list.filter((x) => !(x && x.type === "mina"));
  list.unshift(item);
  list = list.slice(0, 10);
  $nobyda.write(JSON.stringify(list), "BYD_Cookies");

  const brief =
    "op=" +
    (item.opType || "-") +
    " bodyLen=" +
    (item.bodyLen || 0) +
    " hasB64=" +
    (item.bodyB64 ? 1 : 0) +
    " at=" +
    (item.update || snap.update || "-");
  if (opts.notify && Notify) {
    $nobyda.notify("比亚迪凭证已自动暂存", item.name || "mina", brief + "\n定时任务将回放该包；若积分不变可明天点签后对照");
  }
  return brief;
}

function markLastMinaAsSign() {
  let last = pickBestMinaCandidate();
  if (!last || !(last.body || last.bodyB64) || !last.url) {
    return (
      "标记失败：还没有可用 mina 抓包。\n" +
      "请先打开比亚迪 App 进入签到页点一次签到，确认日志有 [BYD mina] bodyLen>0，再 MarkMinaAsSign=true 运行"
    );
  }
  if (!isPromotableMina(last)) {
    return (
      "标记失败：最近包不是可回放的 dynasty.srv（可能是 switches/getUnionResource）。\n" +
      "请进入每日签到页并点签到后立刻再标记"
    );
  }

  const item = normalizeCookie(
    Object.assign({}, last, {
      type: "mina",
      name: "mina签到(手动标记)",
      signLike: true,
      _manual: true
    })
  );
  if (!item) return "标记失败：normalize 失败";
  promoteMinaSnap(last, { name: "mina签到(手动标记)", notify: false, manual: true });

  return (
    "已标记最近 mina 请求为签到凭证 ✅\n" +
    `op: ${item.opType || "-"}\n` +
    `bodyLen: ${item.bodyLen || String(item.body || "").length}\n` +
    `hex: ${item.bodyHex || toHexPreview(item.body, 16)}\n` +
    `hasB64: ${item.bodyB64 ? 1 : 0}\n` +
    `capturedAt: ${item.update || last.update || "-"}\n` +
    "说明：已按「最新 dynasty.srv」选取（不是 body 最大）\n" +
    "请立刻把 MarkMinaAsSign 改回 false，再手动运行一次任务做回放验证\n" +
    "若回放仍失败：把通知里的 http/respHex/BYD_LastReplay 发我"
  );
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
    // bodyBytes 场景不要强行写 JSON Content-Type
    const hasBinaryBody = !!(options && options.bodyBytes);
    if (options.body && !hasBinaryBody && !options.headers["Content-Type"] && !options.headers["content-type"]) {
      options.headers["Content-Type"] = "application/json; charset=UTF-8";
    }
    // 同时存在 bodyBytes 时，避免 string body 干扰
    if (hasBinaryBody && options.body != null) {
      try { delete options.body; } catch (e) { options.body = undefined; }
    }
    if (isQuanX) {
      if (typeof options == "string") options = { url: options };
      options["method"] = "POST";
      $task.fetch(options).then(
        (response) => {
          // 优先 body（文本）；若 body 为空且有 bodyBytes，仍把 body 回传（QX 通常会填 body 为 latin1 字符串）
          const payload = response && (response.body != null ? response.body : response.bodyBytes);
          callback(null, adapterStatus(response), payload);
        },
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
      // node 下 bodyBytes 转 Buffer
      if (hasBinaryBody) {
        try {
          const u8 = options.bodyBytes instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(options.bodyBytes))
            : Buffer.from(options.bodyBytes);
          options.body = u8;
          delete options.bodyBytes;
        } catch (e) {}
      }
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
