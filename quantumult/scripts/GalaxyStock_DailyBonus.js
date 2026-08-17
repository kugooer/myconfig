/*************************

  银河证券（中国银河证券 App）每日签到

  更新时间: 2026-08-17 (capture-v1.0)
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  抓包结论（2026-08-17）:
  - 签到接口: POST https://mall.chinastock.com.cn/h5_gateway/smart-trade/vip/checkIn
    body: {}  (Content-Type: application/json)
    响应: {"ret":{"error":"0","msg":"操作成功"},"data":1}  → 成功
  - 凭证: 请求头 Cookie 中的 SESSION=xxx（打开 App 后 H5 自动请求 vip 系列接口时携带）
  - 触发: App 内 H5 (cdns.chinastock.com.cn) 自动请求
    /h5_gateway/smart-trade/vip/activityStatus|customerFreeRight|checkIn ... 即可抓到 SESSION

  行为:
  1) MitM 命中 mall.chinastock.com.cn/h5_gateway/smart-trade/vip/* → 提取 SESSION 持久化
  2) 打开 App 自动签到: 抓到 SESSION 后延时 1~3 秒自动调用 checkIn（同日仅一次，5 分钟去抖）
  3) 定时任务兜底: 读已存 SESSION 直接签到

  注意:
  - 仅在登录状态下 SESSION 有效; 重登后需重新打开 App 任意页刷新凭证
  - 禁止用于会员解锁类用途

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

var LogDetails = false;
var Notify = true;
// 打开 App 后自动签到（主模式）
var AutoSignOnOpen = true;
// 打开 App 后等待 1~3 秒再签到（毫秒）
var AutoDelayMin = 1000;
var AutoDelayMax = 3000;
// 同日打开 App 只自动签一次（配合 5 分钟去抖，避免并发命中重复签到）
var OpenAppOncePerDay = true;
// 签到成功后的奖励提示（可自行修改）
var RewardTip = "今天签到完成，奖励抽中智能VIP 1天特权。VIP到期日：2027-09-19";

var $nobyda = nobyda();
var PREFIX = "GS";
var HOST = "mall.chinastock.com.cn";
var SIGN_PATH = "/h5_gateway/smart-trade/vip/checkIn";
var DefaultUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148/ChinaStockApp theme/light lang/zh-CN";

(async () => {
  try {
    if ($nobyda.isRequest) {
      // —— MitM 命中：抓 SESSION + 打开 App 自动签到 ——
      const needDelay = GetCookie();
      if (needDelay) {
        const delay = AutoDelayMin + Math.floor(Math.random() * (AutoDelayMax - AutoDelayMin));
        console.log("[GS] 打开App自动签到: " + delay + "ms 后发起");
        setTimeout(() => {
          $nobyda.write(String(Date.now()), PREFIX + "_AutoTime"); // 先打去抖标记
          doCheckIn(needDelay, "open"); // 发起签到（不阻塞 done）
          $nobyda.done();
        }, delay);
      } else {
        $nobyda.done();
      }
      return;
    }

    // —— 定时任务 / 手动运行：读凭证直接签到 ——
    const session = $nobyda.read(PREFIX + "_Session");
    if (!session || !session.trim()) {
      throw new Error("未抓到 SESSION 凭证：请先打开银河证券 App 任意页面（MitM 生效后自动抓取）");
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
    $nobyda.done();
  }
})();

/**
 * 抓取 SESSION cookie（isRequest 分支）
 * @returns {string|false} 需要自动签到时返回 SESSION，否则 false
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
  // 5 分钟去抖：避免 App 并发请求/多次命中重复签到
  const last = parseInt($nobyda.read(PREFIX + "_AutoTime") || "0", 10);
  if (Date.now() - last < 5 * 60 * 1000) {
    console.log("[GS] 去抖窗口内（5min），跳过自动签到");
    return false;
  }
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

function dayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
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
    if (isQuanX) $notification.post(title, subtitle || "", message || "");
    if (isSurge || isLoon) $notification.post(title, subtitle || "", message || "");
    if (isNode) console.log("[GS] notify: " + m);
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
