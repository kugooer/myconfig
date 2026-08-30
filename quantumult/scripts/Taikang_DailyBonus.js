/*************************

  泰康在线（微信小程序 wx9e3e7020c4a10356）每日领金币

  更新时间: 2026-08-30 (capture-v1.0)
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  抓包结论（2026-08-30 15:33 实测）:
  - 入口: 微信小程序「泰康在线」(wx9e3e7020c4a10356 / page 395)
  - 4 个奖励动作（全为 POST，响应均为明文 JSON）:
      1) 登录签到       5  金币  → /activity_execute/rest/membergoldbean/sign
      2) 每日打卡 1000 步 15 金币 → /promotion/activity_execute/rest/springOuting/draw  (drawSource=dailyOneK)
      3) 每日打卡 5000 步 30 金币 → /promotion/activity_execute/rest/springOuting/draw  (drawSource=dailyFiveK)
      4) 每日打卡 10000步 50 金币 → /promotion/activity_execute/rest/springOuting/draw  (drawSource=dailyTenK)
  - 请求体全部走自定义 `enc` 包装: {"enc":true,"encData":"<hex>"}，密钥嵌在
    微信小程序 JS 内、无法从抓包还原 → 走「路线 B frozen payload 重放」
  - draw 系列额外带 Authorization（会话级，长效）和 Signature（per-request
    HMAC-like，绑定 body）。直接重放 body+headers 原样即可
  - 响应字段: signAmount/glodbean 表示本次奖励，amount/totalGoldbeanAmount
    表示当前账户金币总额；error_code=="0" 视为成功

  用法:
  1) 挂 task；首次运行直接用脚本内默认 frozen payload
  2) 若服务端对 encData 引入时间戳/防重放导致过期，重新打开小程序走到
     「每日签到福利」页（无需点任何按钮，只需进页触发抓包），用同样方式
     重抓 4 个 encData + Authorization + Signature，替换脚本内 Payloads 段
  3) 通知 4 段奖励汇总

*************************

【推荐挂载 · Quantumult X】
----------------
任务引用:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/Taikang_DailyBonus.task

脚本本体:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/Taikang_DailyBonus.js

*************************/

var Notify = true;
var out = 8000; // 单次 fetch 超时

var $nobyda = nobyda();
var PREFIX = "Taikang";
var HOST = "m.tk.cn";
var WX_APPID = "wx9e3e7020c4a10356";
var WX_PAGE = 395;
var Referer = "https://servicewechat.com/" + WX_APPID + "/" + WX_PAGE + "/page-frame.html";
var DefaultUA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.76(0x18004c2c) NetType/WIFI Language/zh_CN";

// === Frozen payloads（2026-08-30 15:33 抓取，完整 request body + 必需 headers） ===
// 字段：name, expectCoin（用于通知校对）, expectSource（drawSource / sign）, path, headers, body
var Payloads = [
  {
    name: "登录签到",
    expectCoin: 5,
    expectSource: "sign",
    path: "/activity_execute/rest/membergoldbean/sign",
    headers: {
      "content-type": "application/json",
      "User-Agent": DefaultUA,
      "Referer": Referer
    },
    body:
      '{"enc":true,"encData":"B3DCD0056B2C7EBDC85FB45615B3B81FF394B5514B104B4E7AD15920DAC89B622099CBF16EFC73F19A281A67E9910DBAFD342D385CFDF59540C54D790AAD1B948D0E813FF1A339BE951BF4122A29D00704D203FCD11F2D01A65A07AD6382860942245F7FFEE9B46DBA0C42973B9B0FF28446C918DDB0C6ED805EC1CCC5CB092C8A7F8A62C98634D08F687844C2E6FB0273016F4EF2750E55AEC008DA3555159A2A3E6805F6EBD5CB6C316E28A79E1920F47BDEC6311CF23F195C680D3D191B347AB47454D6C357E5DAE66E156C102423E6A1D812FA9581460AD8612316BB5D8F907B10D75CE2B4F638F83471157F1DC176B67507DE64E98C3608CA06AD77481BFD05A06B5AB5FA3F84A0A4194F465124DFE7FD922423BC5E20C134D8424F728ABCE307B631C6AAADCBC7D7AA6732506792D5B32769BA3D9C53A939B5D407909E71539168C92A98839A6C671A8F5D610533B11CAC113EAF7837E2DB388D690DFC"}'
  },
  {
    name: "每日打卡1000步",
    expectCoin: 15,
    expectSource: "dailyOneK",
    path: "/promotion/activity_execute/rest/springOuting/draw",
    headers: {
      "content-type": "application/json",
      "User-Agent": DefaultUA,
      "Referer": Referer,
      Authorization:
        "D8920E7A3D72DB2F1A3BB6445AB743434D329E2A092D20FAB07FAAEF7548F3E6C6255D3AA32B50945C3C1BC19C7972B9E846722A035DDB45EC0D4CBA5A3B52CEA1BB44D0C05D4934880CBEDFA584FFCE4E14C2E723EE22B69F427A74EC7962E5",
      Signature:
        "D0A8E75CABC6CC5C9937A5604A3A722A29639006F675BFB5F96A5D86E5A11460DDD7ABDCBBDADE641BEB6BEDA2F7E58A9621F1E0378B79B8C6F9A0DBF729E0B338D99CC6B02BE177069D30635F209A77210F1A0DB95F3A6075555E1DEBF2C7D1CA0CDEF4851EE10725B93FDA9D6543D04A9911D89F911F0EC72D4F5AD95775A122B559490D85C190558D03E86097D088"
    },
    body:
      '{"enc":true,"encData":"E3D409147A3678E02E51FD53EBBEEBC45FEF6A153651A7F13309FD281461037714E925C0915945BD27FED35A9FFAAA91B39B55A86DD2591A4650D4ECFC62244CF14F4D4879CDE56F9C243CB3070EED577B627027BE376706F8A1C46CF198C64DDDCA1243715C2269C3000738B35B7DA49571D53AA805BC5E6B304D99ADA86416BD68171206DD5F49766C31FBA583CA651379011452242FE2CE24F5301CD143D7C4894BD2A9651DB907DBE6B82296D206530651C97498E71C04E53F3297CD5162456AD276E40A403FCD474F7D4C12F1540C213FF00D829D0C18AF3E4DEE1BE6212DC01E17E358859CE6F808C9226E6A77A7A84D69F7F8670A6BDD17CF07462800864182D0C02B9800A1A9B36CB2A2F0B7"}'
  },
  {
    name: "每日打卡5000步",
    expectCoin: 30,
    expectSource: "dailyFiveK",
    path: "/promotion/activity_execute/rest/springOuting/draw",
    headers: {
      "content-type": "application/json",
      "User-Agent": DefaultUA,
      "Referer": Referer,
      Authorization:
        "D8920E7A3D72DB2F1A3BB6445AB743434D329E2A092D20FAB07FAAEF7548F3E6C6255D3AA32B50945C3C1BC19C7972B9E846722A035DDB45EC0D4CBA5A3B52CEA1BB44D0C05D4934880CBEDFA584FFCE4E14C2E723EE22B69F427A74EC7962E5",
      Signature:
        "D0A8E75CABC6CC5C9937A5604A3A722A29639006F675BFB5F96A5D86E5A114607680930C62C4C956800F05136BE9152BC5FB919BAF4F30F7AF7E344356806041311A68C76364A265DEAC0C4920DD26E770F467103A6A23F831D65A2BB201F10A080F6323CD01B0E5205382DC9D80E45FCB68D71E59CB6AD030D9620DDB6FB613AFB2CDF3F037098EBBB735AFCDF8F909"
    },
    body:
      '{"enc":true,"encData":"E3D409147A3678E02E51FD53EBBEEBC45FEF6A153651A7F13309FD281461037714E925C0915945BD27FED35A9FFAAA91B39B55A86DD2591A4650D4ECFC62244CF14F4D4879CDE56F9C243CB3070EED577B627027BE376706F8A1C46CF198C64DDDCA1243715C2269C3000738B35B7DA49571D53AA805BC5E6B304D99ADA86416BD68171206DD5F49766C31FBA583CA651379011452242FE2CE24F5301CD143D7C4894BD2A9651DB907DBE6B82296D206530651C97498E71C04E53F3297CD5162456AD276E40A403FCD474F7D4C12F1540C213FF00D829D0C18AF3E4DEE1BE6212DC01E17E358859CE6F808C9226E6A77A7A84D69F7F8670A6BDD17CF07462800A7BF08B526D071E0B3E144D651F8DB8F33B11CAC113EAF7837E2DB388D690DFC"}'
  },
  {
    name: "每日打卡10000步",
    expectCoin: 50,
    expectSource: "dailyTenK",
    path: "/promotion/activity_execute/rest/springOuting/draw",
    headers: {
      "content-type": "application/json",
      "User-Agent": DefaultUA,
      "Referer": Referer,
      Authorization:
        "D8920E7A3D72DB2F1A3BB6445AB743434D329E2A092D20FAB07FAAEF7548F3E6C6255D3AA32B50945C3C1BC19C7972B9E846722A035DDB45EC0D4CBA5A3B52CEA1BB44D0C05D4934880CBEDFA584FFCE4E14C2E723EE22B69F427A74EC7962E5",
      Signature:
        "D0A8E75CABC6CC5C9937A5604A3A722A29639006F675BFB5F96A5D86E5A11460C543D44547B243F15C5D3979A82DCC90C3CC2D61907EEB6CDD10F301C1F0B101EA9B20141A9EA9D3144533FE4632DCA943EAF63CE9FCC34C45D4DC773C6B96112A795C5C026B78361B6DF37E6864D11B7312A4AAB950328059EAAA1554D165552F5847EAEABFB20D474771BE25C22443"
    },
    body:
      '{"enc":true,"encData":"E3D409147A3678E02E51FD53EBBEEBC45FEF6A153651A7F13309FD281461037714E925C0915945BD27FED35A9FFAAA91B39B55A86DD2591A4650D4ECFC62244CF14F4D4879CDE56F9C243CB3070EED577B627027BE376706F8A1C46CF198C64DDDCA1243715C2269C3000738B35B7DA49571D53AA805BC5E6B304D99ADA86416BD68171206DD5F49766C31FBA583CA651379011452242FE2CE24F5301CD143D7C4894BD2A9651DB907DBE6B82296D206530651C97498E71C04E53F3297CD5162456AD276E40A403FCD474F7D4C12F1540C213FF00D829D0C18AF3E4DEE1BE6212DC01E17E358859CE6F808C9226E6A77A7A84D69F7F8670A6BDD17CF074628007800DC83E13F03745A29FD54E42AECE7"}'
  }
];

var merge = {};

(async () => {
  try {
    if ($nobyda.isRequest) {
      // 本脚本无需 MitM 抓凭证；rewrite 不挂
      $nobyda.done({});
      return;
    }
    for (let i = 0; i < Payloads.length; i++) {
      await doAction(Payloads[i], i + 1);
    }
    await notifyDone();
  } catch (e) {
    if (!$nobyda.isRequest) {
      $nobyda.notify("泰康在线领金币", "异常", String(e.message || e));
      console.log("\n" + (e.stack || e));
    }
  } finally {
    if (!$nobyda.isRequest) {
      $nobyda.time();
      $nobyda.done();
    }
  }
})();

function doAction(p, index) {
  merge["act" + index] = { name: p.name, expectCoin: p.expectCoin, expectSource: p.expectSource };
  return new Promise((resolve) => {
    const url = "https://" + HOST + p.path;
    const options = {
      url,
      method: "POST",
      headers: p.headers,
      body: p.body
    };
    if (out) options.timeout = out;
    $nobyda.post(options, function (error, response, data) {
      const slot = merge["act" + index];
      try {
        if (error) {
          slot.ok = false;
          slot.msg = "网络错误: " + error;
          console.log("[" + p.name + "] " + slot.msg);
          return resolve();
        }
        const status = response && (response.statusCode || response.status);
        const obj = safeJSON(data);
        if (!obj) {
          slot.ok = false;
          slot.msg = "响应非 JSON（HTTP " + status + "）";
          console.log("[" + p.name + "] " + slot.msg + "\n" + String(data || "").slice(0, 200));
          $nobyda.write(summarizeForDiag(p, status, data, null), PREFIX + "_LastReplay_" + index);
          return resolve();
        }
        const code = String(obj.error_code || "");
        if (code !== "0") {
          slot.ok = false;
          slot.msg = "业务错误 " + code + " " + (obj.error_message || "");
          console.log("[" + p.name + "] " + slot.msg);
          $nobyda.write(summarizeForDiag(p, status, data, obj), PREFIX + "_LastReplay_" + index);
          return resolve();
        }
        const data2 = obj.data || {};
        // sign 系列: signAmount；draw 系列: glodbean
        const gotCoin = Number(data2.signAmount || data2.glodbean || 0);
        const gotSource = data2.drawSource || p.expectSource || "";
        slot.ok = true;
        slot.coin = gotCoin;
        slot.source = gotSource;
        slot.total = Number(data2.amount || data2.totalGoldbeanAmount || 0);
        slot.todayIsSub = data2.todayIsSub || "";
        console.log(
          "[" + p.name + "] ✅ +" + gotCoin + " 金币 (source=" + gotSource + ", total=" + slot.total + ", todayIsSub=" + slot.todayIsSub + ")"
        );
        $nobyda.write(summarizeForDiag(p, status, data, obj), PREFIX + "_LastReplay_" + index);
      } catch (e) {
        slot.ok = false;
        slot.msg = "处理异常: " + (e.message || e);
        console.log("[" + p.name + "] " + slot.msg);
      }
      resolve();
    });
  });
}

function summarizeForDiag(p, status, raw, obj) {
  return JSON.stringify({
    at: new Date().toISOString(),
    name: p.name,
    path: p.path,
    status: status,
    code: obj && obj.error_code,
    msg: obj && obj.error_message,
    coin: obj && obj.data && (obj.data.signAmount || obj.data.glodbean),
    total: obj && obj.data && (obj.data.amount || obj.data.totalGoldbeanAmount),
    head: String(raw || "").slice(0, 200)
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

async function notifyDone() {
  const lines = [];
  let totalCoin = 0;
  let okCount = 0;
  let failCount = 0;
  for (let i = 1; i <= 4; i++) {
    const slot = merge["act" + i];
    if (!slot) continue;
    if (slot.ok) {
      okCount++;
      totalCoin += Number(slot.coin || 0);
      lines.push("✅ " + slot.name + " +" + slot.coin + "金币");
    } else {
      failCount++;
      lines.push("❌ " + slot.name + " " + (slot.msg || "失败"));
    }
  }
  // 最后一个成功的 total
  let lastTotal = 0;
  for (let i = 4; i >= 1; i--) {
    if (merge["act" + i] && merge["act" + i].ok) {
      lastTotal = merge["act" + i].total || 0;
      break;
    }
  }
  const title = "泰康在线领金币";
  const sub = okCount + "/4 成功 · 本次 +" + totalCoin + " 金币";
  const msg =
    lines.join("\n") +
    (lastTotal ? "\n账户余额: " + lastTotal + " 金币" : "") +
    (failCount ? "\n\n⚠️ 失败项需重新打开小程序「每日签到福利」页抓包更新 frozen payload" : "");
  if (Notify) $nobyda.notify(title, sub, msg);
  console.log("\n" + title + "\n" + sub + "\n" + msg);
}

function nobyda() {
  const start = Date.now();
  const isRequest = typeof $request != "undefined";
  const isSurge = typeof $httpClient != "undefined";
  const isQuanX = typeof $task != "undefined";
  const isLoon = typeof $loon != "undefined";
  const isNode = typeof require == "function" && typeof $request === "undefined";
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
  };
  const write = (value, key) => {
    if (isQuanX) return $prefs.setValueForKey(value, key);
    if (isSurge) return $persistentStore.write(value, key);
    if (isNode) {
      try {
        const fs = require("fs");
        const path = "taikang_cookie.json";
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
        const path = "taikang_cookie.json";
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
  const time = () => {
    const end = ((Date.now() - start) / 1000).toFixed(2);
    return console.log("\n签到用时: " + end + " 秒");
  };
  const done = (value = {}) => {
    if (isQuanX) return isRequest ? $done(value) : $done();
    if (isSurge) return isRequest ? $done(value) : $done();
  };
  return { isRequest, isQuanX, isSurge, isNode, notify, write, read, post, time, done };
}
