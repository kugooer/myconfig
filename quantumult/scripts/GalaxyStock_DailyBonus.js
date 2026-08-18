/*************************

  银河证券（中国银河证券 App）每日签到

  更新时间: 2026-08-18 (capture-v1.7)
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  v1.1 修复（2026-08-17 09:50 用户日志）:
  - QX 通知 API 改为 $notify()（$notification 是 Surge/Loon 专属，QX 报 undefined）
  - 打开App自动签到改为「命中即同步 fire + 立即 done」：
    不再依赖 setTimeout（QX 在 $done 后会终止脚本上下文，$done 后/依赖定时器
    的回放会被杀——BYD capture-v9.1/9.2 已验证）。$task.fetch 在 $done 之前
    同步发起，fetch 回调（写 AutoDate + 通知）仍会执行。
    「打开后 1~3 秒签到」由链路天然承担：打开 App → 进智能VIP页 → H5 发请求，
    命中时已距打开 1~3 秒；脚本命中即签，不再额外等待。
  - 并发命中用持久化 lock 去抖（GS_OpenSignLock 120s）
  - 同日只自动签一次（GS_AutoDate）
  - 异步 IIFE 的 finally 不再对 isRequest 分支重复 done

  v1.2 修复（2026-08-17 09:58 用户日志）:
  - fire 后无 checkIn HTTP 日志/无结果通知：QX 在 $done 后常终止脚本上下文，
    $task.fetch 回调可能不执行（BYD result 通知「尽量」同因）
  - 改为「等待签到完成（最多 2.5s 超时兜底）再 $done 放行原请求」：
    保证 fetch 回调在 $done 前执行完，签到结果通知 100% 可靠
    银河 checkIn 响应快(<500ms)，对被拦截的 H5 请求影响极小

  v1.3 修复（2026-08-17 10:02 用户日志）:
  - v1.2 等待 Promise 仍无 checkIn HTTP：脚本主流程 return 后 QX 终止异步上下文，
    $task.fetch 回调不执行、Promise 恒 pending → 等不到
  - 改为 isRequest 分支 **await** doCheckIn（Promise.race 含 2.5s 超时兜底）：
    脚本主流程保持存活直到签到完成，回调必然执行、结果通知可靠
  - 新增超时/完成路径日志，便于区分「fetch 正常」与「回调未执行」

  v1.4 扩展（2026-08-17 用户需求: 登录后自动触发，不进VIP页）:
  - 触发面从 vip/* 扩展到整个 mall 网关 h5_gateway/*：
    若 H5 登录页/登录后初始化也走 mall 网关域，登录完成即触发签到
  - 新增「命中」日志（打印 URL），用于确认登录链路是否触发脚本
  - 签到判定不变：仅当请求头带 SESSION 且同日未签/去抖外才签到；无 SESSION 直接放行
  - 定时任务保留为可选兜底；用户每日登录模式不依赖它

  v1.5 诊断版（2026-08-17 用户实测: 登录后无任何命中）:
  - 结论: 登录流程不走 mall 网关域 → v1.4 扩面无效（连命中日志都没有）
  - 诊断目的: hostname 临时扩至 *.chinastock.com.cn 全域，打印每个命中请求的
    URL / SESSION 有无 / Host，定位「登录后自动加载且带 SESSION」的触发域
  - 签到逻辑保留：若命中请求带 SESSION 且同日未签 → 直接签到（诊断期即达目的）
  - 确认触发域后收窄 hostname 回单一域（诊断版性能开销大，勿长期使用）

  v1.6 收窄恢复（2026-08-17 诊断完成）:
  - v1.5 全域诊断结论: 面容解锁登录/启动链路只有 CDN 图片(infoanaly/cdns)与原生 API，
    全域无 SESSION → QX 重写层无登录触发点，物理不可行
  - hostname 收窄回 mall.chinastock.com.cn，恢复 v1.3 可靠链路（进智能VIP页自动签）
  - 命中日志保留精简版（仅 URL），便于后续排查

  v1.7 修复（2026-08-18 07:39 用户日志）:
  - 时区 bug：QX JavaScriptCore 运行时时区为 UTC（非设备时区），
    北京时间 00:00~08:00 期间 new Date().getDate() 返回的是 UTC 日期（前一天）
    → dayStr() 误判为"昨天" → GS_AutoDate 恒等 → 同日去重失效、签到被跳过
  - 修复：dayStr() 改为强制东八区（UTC+8）计算，不依赖运行环境时区
  - 影响：GS_AutoDate 同日去重 + 定时任务跳过判断，均依赖 dayStr()

  抓包结论（2026-08-17）:
  - 签到接口: POST https://mall.chinastock.com.cn/h5_gateway/smart-trade/vip/checkIn
    body: {}  (Content-Type: application/json)
    响应: {"ret":{"error":"0","msg":"操作成功"},"data":1}  → 成功
  - 凭证: 请求头 Cookie 中的 SESSION=xxx（进入「智能VIP/VIP中心」H5 页面时携带）
  - 触发: 仅打开 App 首页不请求 mall.chinastock.com.cn；
    需进入 smartTrade-Vip H5（智能VIP中心）页面，H5 自动请求 vip 系列接口

*************************

【推荐挂载 · Quantumult X】
----------------
重写引用:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/GalaxyStock_DailyBonus.conf

任务引用:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/GalaxyStock_DailyBonus.task

脚本本体:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/GalaxyStock_DailyBonus.js

*************************/

var Notify = true;
// 打开 App（进智能VIP/VIP中心页）后自动签到（主模式）
var AutoSignOnOpen = true;
// 同日打开 App 只自动签一次
var OpenAppOncePerDay = true;
// 并发去抖窗口（毫秒）：App 同时发多个 vip 请求时只签一次
var OpenSignLockMs = 120 * 1000;
// 打开App自动签到：等待签到完成的超时上限（毫秒），超时则直接放行原请求
var OpenSignWaitMs = 2500;
// 签到成功后的奖励提示（可自行修改）
var RewardTip = "今天签到完成，奖励抽中智能VIP 1天特权。VIP到期日：2027-09-19";

var $nobyda = nobyda();
var PREFIX = "GS";
var HOST = "mall.chinastock.com.cn";
var SIGN_PATH = "/h5_gateway/smart-trade/vip/checkIn";
var DefaultUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148/ChinaStockApp theme/light lang/zh-CN";

// isRequest 分支自行管理 $done，finally 不重复 done
var isRequestMode = false;

(async () => {
  try {
    if ($nobyda.isRequest) {
      isRequestMode = true;
      // 命中日志（精简版）：确认触发动作是否命中脚本
      console.log("[GS] 命中: " + ($request && $request.url || "?"));
      const session = GetCookie();
      if (session) {
        // 打开App自动签到：**await** 等待签到完成（最多 OpenSignWaitMs 超时兜底）。
        // 关键：主流程 await 保持脚本存活，$task.fetch 回调必然执行（v1.2 的
        // fire-and-forget 在 return 后被 QX 终止上下文、Promise 恒 pending → 等不到）
        console.log("[GS] 打开App自动签到 fire");
        await raceTimeout(doCheckIn(session, "open"), OpenSignWaitMs);
        console.log("[GS] 打开App自动签到流程结束，放行原请求");
        $nobyda.done();
        return;
      }
      $nobyda.done();
      return;
    }

    // —— 定时任务 / 手动运行：读凭证直接签到 ——
    const session = $nobyda.read(PREFIX + "_Session");
    if (!session || !session.trim()) {
      throw new Error("未抓到 SESSION 凭证：请打开银河证券 App 进入智能VIP/VIP中心页面");
    }
    if (OpenAppOncePerDay && $nobyda.read(PREFIX + "_AutoDate") === dayStr()) {
      console.log("[GS] 今日已通过打开App自动签到，跳过定时任务");
      if (Notify) $nobyda.notify("银河证券签到", "", "今日已签到完成（打开App自动签到）");
      return;
    }
    await doCheckIn(session.trim(), "task");
  } catch (e) {
    $nobyda.notify("银河证券签到", "", String(e.message || e));
    console.log("\n" + (e.stack || e));
  } finally {
    $nobyda.time();
    if (!isRequestMode) $nobyda.done();
  }
})();

/**
 * 抓取 SESSION cookie（isRequest 分支）
 * @returns {string|false} 需要自动签到时返回 SESSION（并已写去抖 lock），否则 false
 */
function GetCookie() {
  const hd = ($request && $request.headers) || {};
  const cookieStr = hd["Cookie"] || hd["cookie"] || hd["COOKIE"] || "";
  const m = cookieStr.match(/SESSION=([^;\s]+)/);
  if (!m || !m[1]) {
    console.log("[GS] 未在请求头发现 SESSION（可能是埋点/静态资源）");
    return false;
  }
  const session = "SESSION=" + m[1];
  const old = $nobyda.read(PREFIX + "_Session");
  if (old !== session) {
    $nobyda.write(session, PREFIX + "_Session");
    console.log("[GS] SESSION 凭证已更新 len=" + session.length);
    if (Notify) $nobyda.notify("银河证券签到", "", "SESSION 凭证已更新，打开App自动签到已就绪");
  }

  if (!AutoSignOnOpen) return false;
  // 同日只自动签一次
  if (OpenAppOncePerDay && $nobyda.read(PREFIX + "_AutoDate") === dayStr()) {
    console.log("[GS] 今日已自动签到，跳过");
    return false;
  }
  // 持久化 lock 去抖：App 并发多个 vip 请求时只签一次
  const lock = parseInt($nobyda.read(PREFIX + "_OpenSignLock") || "0", 10);
  if (Date.now() - lock < OpenSignLockMs) {
    console.log("[GS] 去抖窗口内（" + (OpenSignLockMs / 1000) + "s），跳过自动签到");
    return false;
  }
  // 同步写 lock（fire 前，保证并发命中互斥）
  $nobyda.write(String(Date.now()), PREFIX + "_OpenSignLock");
  return session;
}

/**
 * 调用签到接口
 * @param {string} session SESSION cookie 串
 * @param {string} mode    open=打开App自动签 / task=定时任务
 * @returns {Promise}
 */
function doCheckIn(session, mode) {
  return new Promise((resolve) => {
    const options = {
      url: "https://" + HOST + SIGN_PATH,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Origin: "https://cdns.chinastock.com.cn",
        Referer: "https://cdns.chinastock.com.cn/",
        "User-Agent": DefaultUA,
        Cookie: session
      },
      body: "{}"
    };
    $nobyda.post(options, (error, response, data) => {
      try {
        if (error) throw new Error(error);
        const httpStatus = response && (response.statusCode || response.status);
        console.log("[GS] " + mode + " checkIn HTTP " + httpStatus + " resp: " + String(data || "").slice(0, 300));
        const cc = safeJSON(data);
        let msg = "";
        if (cc && cc.ret) {
          if (String(cc.ret.error) === "0") {
            msg = RewardTip;
            // 标记当日完成（仅成功时）
            $nobyda.write(dayStr(), PREFIX + "_AutoDate");
          } else {
            msg = "签到失败: " + (cc.ret.msg || ("error=" + cc.ret.error));
          }
        } else {
          msg = "签到响应异常(HTTP " + httpStatus + ")";
        }
        if (Notify) $nobyda.notify("银河证券签到", "", msg);
      } catch (eor) {
        $nobyda.AnError("银河证券签到", "Sign", eor, response, data);
      } finally {
        resolve();
      }
    });
  });
}

/**
 * Promise 超时兜底：ms 内未 settle 则 resolve（不阻塞原请求过久）
 * 超时仅影响「放行时机」，fetch 仍可能在后台完成（结果通知尽力而为）
 */
function raceTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => {
        console.log("[GS] 等待签到完成超时（" + ms + "ms），直接放行原请求");
        resolve();
      }, ms);
    })
  ]);
}

function dayStr() {
  // 强制东八区（北京时间 UTC+8），避免 QX JavaScriptCore 运行时时区为 UTC
  // 导致北京时间 00:00~08:00 期间 getDate() 返回前一天 → 同日去重失效
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}

function safeJSON(text) {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? j : null;
  } catch (e) {
    return null;
  }
}

function nobyda() {
  const isRequest = typeof $request != "undefined" && $request && typeof $response == "undefined";
  const isSurge = typeof $httpClient != "undefined" && typeof $task == "undefined";
  const isQuanX = typeof $task != "undefined";
  const isLoon = typeof $loon != "undefined";
  const isNode = typeof module != "undefined" && !!module.exports;
  const start = Date.now();

  const notify = (title, subtitle, message) => {
    const m = title + (subtitle ? " - " + subtitle : "") + (message ? "\n" + message : "");
    console.log("[GS] notify: " + m);
    if (Notify === false) return;
    if (isQuanX) $notify(title, subtitle || "", message || ""); // QX: $notify()
    if (isSurge) $notification.post(title, subtitle || "", message || ""); // Surge
    if (isLoon) $notification.post(title, subtitle || "", message || ""); // Loon
  };

  const write = (value, key) => {
    if (isQuanX) return $prefs.setValueForKey(value, key);
    if (isSurge || isLoon) return $persistentStore.write(value, key);
    if (isNode) {
      try {
        const fs = require("fs");
        const p = __dirname + "/" + key + ".json";
        fs.writeFileSync(p, JSON.stringify(value));
      } catch (e) {}
      return value;
    }
  };

  const read = (key) => {
    if (isQuanX) return $prefs.valueForKey(key);
    if (isSurge || isLoon) return $persistentStore.read(key);
    if (isNode) {
      try {
        const fs = require("fs");
        const p = __dirname + "/" + key + ".json";
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch (e) {
        return null;
      }
    }
    return null;
  };

  const adapterStatus = (response) => {
    if (response) {
      if (response.status) response.statusCode = response.status;
      else if (response.statusCode) response.status = response.statusCode;
    }
    return response;
  };

  const post = (options, callback) => {
    if (!options.headers) options.headers = {};
    if (!options.headers["User-Agent"]) options.headers["User-Agent"] = DefaultUA;
    if (options.body && !options.headers["Content-Type"] && !options.headers["content-type"]) {
      options.headers["Content-Type"] = "application/json; charset=UTF-8";
    }
    if (isQuanX) {
      if (typeof options == "string") options = { url: options };
      options.method = "POST";
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
      $httpClient.post(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    }
    if (isLoon) {
      $httpClient.post(options, (error, response, body) => {
        callback(error, adapterStatus(response), body);
      });
    }
    if (isNode) {
      try {
        const request = require("request");
        request.post(options, (error, response, body) => {
          callback(error, adapterStatus(response), body);
        });
      } catch (e) {
        callback("node request 库不可用: " + e.message, null, null);
      }
    }
  };

  const AnError = (name, keyname, er, resp, body) => {
    return console.log(
      "\n‼️" + name + "发生错误\n‼️名称: " + er.name + "\n‼️描述: " + er.message +
      (resp && resp.status ? "\n‼️状态: " + resp.status : "") +
      (body ? "\n‼️响应: " + body : "")
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
    AnError, isRequest, isSurge, isQuanX, isLoon, isNode,
    notify, write, read, post, time, done
  };
}
