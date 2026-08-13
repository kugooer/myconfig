/*************************

  中国移动 App · 登录后即时签到
  语法风格参考 NobyDa/JD_DailyBonus.js
  适用：Quantumult X / Surge / Loon / Node.js

  设计原则（按你的要求）：
  - 不固化、不回放历史签到报文
  - 每次登录成功后，用「本次」会话/凭证，现场动态拼装参数并发起签到
  - 定时任务也会对已保存会话做「现场签到」（参数按当前时间重新生成）

  当前能力：
  1) 捕获 fingerprintLogin 成功会话（JSESSIONID/UID/x-token/UA）
  2) 捕获云盘 Authorization / APP_AUTH（Basic 解码手机号）
  3) 登录成功后立即触发：
     - 云盘签到（明文/可动态签名链路）
     - App 侧可配置 H5 签到点（使用本次会话动态 Header，不复用旧 Body）
  4) 多账号持久化 CookiesCMCC

  限制（事实，不是偷懒）：
  - 中国移动 App 原生 biz-orange 业务体是 x-sign + 密文 body。
    在没有签名算法前，无法伪造原生「签到领奖」密文。
  - 因此「即时动态签到」优先走：
    a) 登录后实时拿到的云盘凭证 → 动态签到
    b) 你可配置的 H5 明文签到入口（URL 可改，body 用本次 token/时间生成）

*************************/

var $nobyda = nobyda();

/********************* 可配置区 *********************/
var LogDetails = false;
var DeleteCookie = false;
var out = 15000; // 单请求超时(ms)
// 登录成功后是否立刻自动签到（核心开关）
var AutoSignAfterLogin = true;
// 登录后延迟多久开始签到，避免会话未完全落地
var SignDelayMs = 800;
// 并发账号间隔
var AccountGapMs = 600;

/**
 * App/H5 签到点（动态模式）：
 * - 每次都会用「当前账号最新 cookie/token/phone/time」生成 headers/body
 * - 不要在这里写死某次抓包的 body
 *
 * 另外：脚本会在 MITM 中自动“学习”疑似签到接口到持久化键 CMCC_SignEndpoints，
 * 并与本数组合并。学习只存 URL/方法/Content-Type 模板，不存历史 body。
 *
 * type:
 *  - "json" : POST JSON
 *  - "form" : POST x-www-form-urlencoded
 *  - "get"  : GET
 *
 * builder: 内置构造器名
 *  - appSessionHeaders : Cookie + x-token + 动态 x-time
 *  - h5TokenQuery      : URL 拼 token/phone/time
 *  - learned          : 学习到的接口（仅保留结构，body 仍按当前账号动态生成）
 *  - none
 */
var SignEndpoints = [
  // 示例：若你抓到 H5 签到页明文接口，按下面格式加进来即可（body/query 动态生成）
  // {
  //   name: "签到领奖-H5",
  //   enabled: true,
  //   type: "json",
  //   url: "https://touch.10086.cn/i/v1/sign/doSign",
  //   builder: "appSessionHeaders",
  //   bodyBuilder: "phoneTimeJson" // { phone, timestamp }
  // }
];

// 自动学习到的端点是否在下次签到时启用（仅「动作类」接口）
var AutoUseLearnedEndpoints = true;
// 学到新接口后立刻再跑一轮：默认关闭，避免页面加载一堆查询接口时连环串号签到
var AutoSignAfterLearn = false;
// 是否清理历史误学习的查询类接口（推荐 true）
var PurgeBadLearnedEndpoints = true;

/********************* 运行时 *********************/
var merge = {};
var ACCOUNT = null;

ReadCookie();

/********************* 入口 *********************/
function ReadCookie() {
  if (DeleteCookie) {
    $nobyda.write("", "CookiesCMCC");
    $nobyda.write("", "CookieCMCC");
    $nobyda.notify("中国移动", "", "已清空 CookiesCMCC");
    return $nobyda.done();
  }

  if ($nobyda.isRequest) {
    // rewrite/mitm 捕获路径：可能同步触发登录后签到
    // QX response 脚本必须透传 body，否则 Content-Length 与 body 不一致报错
    GetCookie().then(() => finishRequest()).catch(e => {
      console.log("GetCookie error: " + e);
      finishRequest();
    });
    return;
  }

  if (PurgeBadLearnedEndpoints) purgeBadLearnedEndpoints();

  // cron / 手动运行
  const list = loadAccounts();
  if (!list.length) {
    $nobyda.notify("中国移动", "", "无账号。请先登录 App 触发会话捕获。");
    return $nobyda.done();
  }

  (async () => {
    for (let i = 0; i < list.length; i++) {
      await all(list[i], { reason: "cron" });
      if (i < list.length - 1) await wait(AccountGapMs);
    }
    $nobyda.done();
  })().catch(e => {
    $nobyda.notify("中国移动", "执行异常", String(e));
    $nobyda.done();
  });
}

async function all(account, opts) {
  ACCOUNT = normalizeAccount(account);
  merge = {};
  $nobyda.time();

  const tag = maskPhone(ACCOUNT.phone || ACCOUNT.uid || "未知");
  console.log(`\n==== 账号 ${tag} / 原因 ${opts && opts.reason || "manual"} ====`);

  // 每次都现场签到，不读取历史 tasks body
  await Promise.all([
    LiveCloudSign(0),
    LiveQwhdSign(0),
    LiveEndpointSign(0)
  ]);

  await notify(tag);
}

function finishRequest() {
  try {
    if (typeof $response !== "undefined" && $response) {
      // 透传原始响应，避免 QX body length not match
      const out = {};
      if ($response.body != null) out.body = $response.body;
      if ($response.headers) out.headers = $response.headers;
      if ($response.status) out.status = $response.status;
      if ($response.statusCode) out.status = $response.status || $response.statusCode;
      return $nobyda.done(out);
    }
  } catch (e) {}
  return $nobyda.done({});
}

/********************* 捕获：登录后立刻签到 *********************/
async function GetCookie() {
  const url = $request.url || "";
  const headers = normalizeHeaders($request.headers || {});
  const body = $request.body || "";
  const respHeaders = $response ? normalizeHeaders($response.headers || {}) : {};
  const respBody = $response ? ($response.body || "") : "";

  // 1) 登录成功
  if (/uamrandcodelogin\/fingerprintLogin/i.test(url) && $response) {
    const setCookie = getHeader(respHeaders, "Set-Cookie") || "";
    const cookie = pickSessionCookie(setCookie) || pickSessionCookie(getHeader(headers, "Cookie"));
    if (!cookie) {
      $nobyda.notify("中国移动", "", "登录成功但未解析到 JSESSIONID");
      return;
    }

    const acc = {
      phone: extractPhoneStrict(body, respBody, headers, setCookie),
      cookie: cookie,
      jsessionid: matchOne(cookie, /JSESSIONID=([^;]+)/i),
      uid: matchOne(cookie, /UID=([^;]+)/i),
      xtoken: getHeader(headers, "x-token") || getHeader(headers, "X-Token") || "",
      userAgent: getHeader(headers, "User-Agent") || "ChinaMobile/12.0.2 (iPhone; iOS 26.4.1; Scale/3.00)",
      updatedAt: Date.now(),
      source: "fingerprintLogin"
    };

    const saved = upsertAccount(acc);
    $nobyda.notify("中国移动", "登录会话已更新", maskPhone(saved.phone || saved.uid || "账号"));

    if (AutoSignAfterLogin) {
      // 用「本次登录」会话立即动态签到
      if (SignDelayMs > 0) await wait(SignDelayMs);
      await all(saved, { reason: "login-trigger" });
    }
    return;
  }

  // 2) 业务请求中刷新会话字段（不落签到模板）
  if (/client\.app\.coc\.10086\.cn|clientaccess\.10086\.cn/i.test(url)) {
    const cookie = pickSessionCookie(getHeader(headers, "Cookie"));
    if (cookie && /JSESSIONID=/i.test(cookie)) {
      upsertAccount({
        phone: extractPhoneStrict(body, respBody, headers),
        cookie: cookie,
        jsessionid: matchOne(cookie, /JSESSIONID=([^;]+)/i),
        uid: matchOne(cookie, /UID=([^;]+)/i),
        xtoken: getHeader(headers, "x-token") || getHeader(headers, "X-Token") || "",
        userAgent: getHeader(headers, "User-Agent") || "",
        h5Cookie: mergeCookieString(getHeader(headers, "Cookie"), getHeader(respHeaders, "Set-Cookie")),
        updatedAt: Date.now(),
        source: "session-refresh"
      }, true);
    }
  }

  // 2.5) 签到 H5 会话（qwhdhub）—— 单独保存 cookie/token，不伪造原生密文
  if (/wx\.10086\.cn\/qwhdhub\//i.test(url)) {
    const setCookie = getHeader(respHeaders, "Set-Cookie") || "";
    const reqCookie = getHeader(headers, "Cookie") || "";
    const h5Cookie = mergeCookieString(reqCookie, setCookie);
    const phone = extractPhoneStrict(body, respBody, headers, reqCookie, setCookie, url);
    const h5Token =
      matchOne(url, /[?&](?:token|accessToken|jt)=([^&]+)/i) ||
      matchOne(reqCookie, /(?:token|accessToken|jt)=([^;]+)/i) ||
      matchOne(String(body || ""), /"(?:token|accessToken|jt)"\s*:\s*"([^"]+)"/i) ||
      "";
    if (h5Cookie || phone || h5Token) {
      upsertAccount({
        phone: phone,
        h5Cookie: h5Cookie,
        h5Token: decodeURIComponentSafe(h5Token),
        userAgent: getHeader(headers, "User-Agent") || "",
        updatedAt: Date.now(),
        source: "qwhdhub-session"
      }, true);
    }
  }

  // 3) 云盘/笔记 Authorization —— 每次登录后的新凭证，现场入库，并可立刻签到
  if (/caiyun\.feixin\.10086\.cn|yun\.139\.com|mcloud\.139\.com|vsbo\.caiyun/i.test(url)) {
    const auth = getHeader(headers, "Authorization") || getHeader(headers, "APP_AUTH") || "";
    if (/Basic\s+/i.test(auth)) {
      const phone = decodeBasicPhone(auth) || extractPhoneStrict(body, respBody, headers);
      const noteToken = getHeader(headers, "NOTE_TOKEN") || "";
      const appNumber = getHeader(headers, "APP_NUMBER") || "";
      const saved = upsertAccount({
        phone: phone,
        cloudAuthorization: auth,
        noteToken: noteToken,
        appNumber: appNumber,
        cloudUA: getHeader(headers, "User-Agent") || "",
        updatedAt: Date.now(),
        source: "cloud-auth"
      });

      // 云盘凭证到来时：仅签「这个手机号」对应账号，绝不回落到其他号
      if (AutoSignAfterLogin && saved.cloudAuthorization && isValidPhone(saved.phone)) {
        ACCOUNT = normalizeAccount(saved);
        merge = {};
        await LiveCloudSign(0);
        await notify(maskPhone(ACCOUNT.phone) + "·云盘即时签到");
      } else if (isValidPhone(phone)) {
        $nobyda.notify("中国移动", "云盘凭证已更新", maskPhone(phone));
      }
    }
  }

  // 4) 自动学习「动作类」明文签到接口（只存模板，不固化 body）
  //    严格排除查询/登录/配置类（taskList/markstatus/sdkAuth/login 等）
  if (looksLikeSignEndpoint(url, body, respBody, headers)) {
    const learned = learnSignEndpoint({
      url: url,
      method: ($request.method || "POST").toUpperCase(),
      headers: headers,
      body: body,
      respBody: respBody,
      respHeaders: respHeaders
    });
    if (learned && learned.added) {
      // 同步保存 H5 cookie/token 到「当前真实号码」
      const phone = extractPhoneStrict(body, respBody, headers, url);
      const h5Cookie = mergeCookieString(getHeader(headers, "Cookie"), getHeader(respHeaders, "Set-Cookie"));
      if (phone || h5Cookie) {
        upsertAccount({
          phone: phone,
          h5Cookie: h5Cookie,
          h5Token: matchOne(url, /[?&](?:token|accessToken)=([^&]+)/i) || "",
          cookie: pickSessionCookie(getHeader(headers, "Cookie")),
          userAgent: getHeader(headers, "User-Agent") || "",
          updatedAt: Date.now(),
          source: "sign-learn"
        }, true);
      }
      $nobyda.notify("中国移动", "已学习签到动作接口", learned.point.name + "\n" + shortUrl(learned.point.url));
      if (AutoSignAfterLearn && isValidPhone(phone)) {
        const acc = findAccountByPhone(phone) || loadAccounts().find(a => a.phone === phone);
        if (acc) {
          if (SignDelayMs > 0) await wait(SignDelayMs);
          await all(acc, { reason: "learn-trigger" });
        }
      }
    }
  }
}

/********************* 动态签到：云盘 *********************/
function LiveCloudSign(s) {
  merge.CloudSign = {};
  return new Promise(resolve => {
    setTimeout(async () => {
      try {
        if (!ACCOUNT.cloudAuthorization && !ACCOUNT.noteToken) {
          merge.CloudSign.notify = "跳过云盘签到：尚无本次云盘凭证";
          return resolve();
        }

        // 动态时间戳（每次不同）
        const ts = Date.now();
        const jwtHeaders = {
          "User-Agent": ACCOUNT.cloudUA || ACCOUNT.userAgent || "Mozilla/5.0 MCloudApp/10.0.1",
          Accept: "*/*",
          Authorization: ACCOUNT.cloudAuthorization || "",
          "Content-Type": "application/json"
        };

        // 步骤 A：用最新 Authorization 换 specToken（动态）
        let ssoToken = "";
        if (ACCOUNT.phone && ACCOUNT.cloudAuthorization) {
          ssoToken = await httpJson("POST",
            "https://orches.yun.139.com/orchestration/auth-rebuild/token/v1.0/querySpecToken",
            jwtHeaders,
            { account: ACCOUNT.phone, toSourceId: "001005" }
          ).then(j => (j && j.success && j.data && j.data.token) || "").catch(() => "");
        }

        // 步骤 B：ssoToken -> jwtToken（动态）
        let jwtToken = "";
        if (ssoToken) {
          jwtToken = await httpJson("POST",
            `https://caiyun.feixin.10086.cn:7071/portal/auth/tyrzLogin.action?ssoToken=${encodeURIComponent(ssoToken)}`,
            {
              "User-Agent": jwtHeaders["User-Agent"],
              Accept: "*/*"
            },
            null
          ).then(j => (j && j.code === 0 && j.result && j.result.token) || "").catch(() => "");
        }

        if (!jwtToken) {
          // 退化：若只有 Authorization，尝试直接查签到状态（部分环境可用）
          merge.CloudSign.notify = "云盘动态鉴权未换到 jwtToken（可能 Authorization 已过期或接口变更）";
          return resolve();
        }

        const signHeaders = {
          "User-Agent": jwtHeaders["User-Agent"],
          Accept: "application/json, text/plain, */*",
          jwtToken: jwtToken,
          Cookie: `jwtToken=${jwtToken}`
        };

        // 步骤 C：查今日是否已签（动态）
        const info = await httpJson("GET",
          `https://caiyun.feixin.10086.cn/market/signin/page/info?client=app&_t=${ts}`,
          signHeaders,
          null
        ).catch(e => ({ __err: String(e) }));

        if (info && info.__err) {
          merge.CloudSign.error = 1;
          merge.CloudSign.notify = "云盘签到查询失败: " + info.__err;
          return resolve();
        }

        const today = !!(info && info.result && info.result.todaySignIn);
        if (today) {
          merge.CloudSign.success = 1;
          merge.CloudSign.notify = "云盘: 今日已签到";
          return resolve();
        }

        // 步骤 D：执行签到（动态）
        // 新版常见：先取 market rule，再 signin
        // 这里采用官方 market 路径族中的动态调用；失败时回退旧 action
        let signed = await tryCloudMarketSign(signHeaders, ts);
        if (!signed.ok) {
          signed = await tryCloudLegacySign(signHeaders, ts);
        }

        if (signed.ok) {
          merge.CloudSign.success = 1;
          merge.CloudSign.notify = "云盘: 签到成功" + (signed.msg ? ` (${signed.msg})` : "");
          if (signed.reward) merge.CloudSign.bean = signed.reward;
        } else {
          merge.CloudSign.error = 1;
          merge.CloudSign.notify = "云盘: 签到未成功" + (signed.msg ? ` · ${signed.msg}` : "");
        }
      } catch (e) {
        merge.CloudSign.error = 1;
        merge.CloudSign.notify = "云盘动态签到异常: " + e;
      } finally {
        resolve();
      }
    }, s);
  });
}

async function tryCloudMarketSign(headers, ts) {
  try {
    // 某些版本通过 manager 配置 + receive 完成
    const conf = await httpJson("GET",
      `https://caiyun.feixin.10086.cn/market/manager/commonMarketconfig/getByMarketRuleName?marketName=sign_in_3&_t=${ts}`,
      headers,
      null
    );
    // 兼容多种返回字段
    const receiveUrl =
      (conf && conf.result && (conf.result.url || conf.result.receiveUrl)) ||
      "https://caiyun.feixin.10086.cn/market/signin/page/sign";

    const r = await httpJson("POST", receiveUrl.indexOf("http") === 0 ? receiveUrl : `https://caiyun.feixin.10086.cn${receiveUrl}`,
      Object.assign({}, headers, { "Content-Type": "application/json" }),
      { client: "app", timestamp: ts }
    );

    const ok = !!(r && (r.code === 0 || r.msg === "success" || r.success === true || (r.result && r.result.success)));
    const msg = (r && (r.msg || r.message)) || "";
    const reward = extractReward(JSON.stringify(r || {}));
    return { ok, msg, reward, raw: r };
  } catch (e) {
    return { ok: false, msg: String(e) };
  }
}

async function tryCloudLegacySign(headers, ts) {
  try {
    // 旧版 form 签到（若仍可用）
    const r = await httpRaw("POST",
      "http://caiyun.feixin.10086.cn:7070/portal/ajax/common/caiYunSignIn.action",
      Object.assign({}, headers, {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest"
      }),
      `op=signin&client=app&t=${ts}`
    );
    let j = null;
    try { j = JSON.parse(r.body || ""); } catch (e) {}
    const ok = !!(j && (j.code === 0 || j.code === 10000 || /success|成功/i.test(JSON.stringify(j))));
    return { ok, msg: (j && (j.msg || j.message)) || `HTTP ${r.status}`, reward: extractReward(r.body || ""), raw: j };
  } catch (e) {
    return { ok: false, msg: String(e) };
  }
}

/********************* 动态签到：qwhdhub 签到领奖（优先） *********************/
function LiveQwhdSign(s) {
  merge.QwhdSign = {};
  return new Promise(resolve => {
    setTimeout(async () => {
      try {
        // 需要 H5 会话。若没有 h5Cookie，尝试用 app cookie 兜底
        const cookie = ACCOUNT.h5Cookie || ACCOUNT.cookie || "";
        if (!cookie && !ACCOUNT.h5Token) {
          merge.QwhdSign.notify = "跳过签到领奖：尚无 qwhdhub H5 会话（请先打开签到页）";
          return resolve();
        }
        const ts = Date.now();
        const headers = {
          Accept: "application/json, text/plain, */*",
          "User-Agent": ACCOUNT.userAgent || "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ChinaMobile",
          "Accept-Language": "zh-CN,zh-Hans;q=0.9",
          Origin: "https://wx.10086.cn",
          Referer: "https://wx.10086.cn/qwhdhub/",
          Cookie: cookie,
          "Content-Type": "application/json;charset=UTF-8"
        };
        if (ACCOUNT.h5Token) {
          headers.token = ACCOUNT.h5Token;
          headers.accessToken = ACCOUNT.h5Token;
        }

        // 1) 查状态
        const statusUrls = [
          "https://wx.10086.cn/qwhdhub/api/mark/mark31/markstatus",
          "https://wx.10086.cn/qwhdhub/api/mark/info/commonInfo"
        ];
        let already = false;
        let statusText = "";
        for (let i = 0; i < statusUrls.length; i++) {
          const r = await httpRaw("POST", statusUrls[i] + (statusUrls[i].indexOf("?") >= 0 ? "&" : "?") + "_t=" + ts, headers, "{}").catch(e => ({ error: String(e) }));
          if (r.error) continue;
          statusText = String(r.body || "");
          if (/已签|今日已签|signed|signStatus"?\s*:\s*1|"isSign"\s*:\s*true|"todaySign"\s*:\s*true/i.test(statusText)) {
            already = true;
            break;
          }
        }
        if (already) {
          merge.QwhdSign.success = 1;
          merge.QwhdSign.notify = "签到领奖: 今日已签到";
          return resolve();
        }

        // 2) 尝试动作接口族（仅动作，不打查询）
        const actionUrls = [
          "https://wx.10086.cn/qwhdhub/api/mark/mark31/doMark",
          "https://wx.10086.cn/qwhdhub/api/mark/mark31/mark",
          "https://wx.10086.cn/qwhdhub/api/mark/doMark",
          "https://wx.10086.cn/qwhdhub/api/mark/mark",
          "https://wx.10086.cn/qwhdhub/api/mark/sign/doSign",
          "https://wx.10086.cn/qwhdhub/api/mark/task/receive"
        ];
        // 合并「已学习且判定为动作」的端点
        resolveSignEndpoints().forEach(p => {
          if (p && p.url && isActionSignUrl(p.url) && actionUrls.indexOf(p.url.split("?")[0]) < 0) {
            actionUrls.push(p.url.split("?")[0]);
          }
        });

        let ok = false;
        let msg = "";
        let reward = "";
        for (let i = 0; i < actionUrls.length; i++) {
          const u = actionUrls[i];
          const bodies = [
            JSON.stringify({ client: "app", timestamp: ts, phone: ACCOUNT.phone || "", mobile: ACCOUNT.phone || "" }),
            JSON.stringify({}),
            `timestamp=${ts}&client=app`
          ];
          for (let bi = 0; bi < bodies.length; bi++) {
            const h = Object.assign({}, headers);
            if (bodies[bi][0] !== "{") h["Content-Type"] = "application/x-www-form-urlencoded";
            else h["Content-Type"] = "application/json;charset=UTF-8";
            const r = await httpRaw("POST", u + (u.indexOf("?") >= 0 ? "&" : "?") + "_t=" + ts, h, bodies[bi]).catch(e => ({ error: String(e), body: "", status: 0 }));
            const text = String((r && r.body) || "");
            if (LogDetails) console.log("qwhd try", u, (r && r.status), text.slice(0, 200));
            if (r && !r.error && (isBizSuccess(text, r.status) || /已签|重复|signed/i.test(text))) {
              ok = true;
              msg = /已签|重复|signed/i.test(text) ? "今日已签" : "签到成功";
              reward = extractReward(text);
              break;
            }
            if (text) msg = text.slice(0, 80);
          }
          if (ok) break;
        }

        if (ok) {
          merge.QwhdSign.success = 1;
          merge.QwhdSign.notify = "签到领奖: " + msg;
          if (reward) merge.QwhdSign.bean = reward;
        } else {
          merge.QwhdSign.error = 1;
          merge.QwhdSign.notify = "签到领奖: 未成功" + (msg ? " · " + msg : "（需在签到页完成 H5 登录态）");
        }
      } catch (e) {
        merge.QwhdSign.error = 1;
        merge.QwhdSign.notify = "签到领奖异常: " + e;
      } finally {
        resolve();
      }
    }, s);
  });
}

/********************* 动态签到：可配置 H5/App 端点 *********************/
function LiveEndpointSign(s) {
  merge.AppSign = {};
  return new Promise(resolve => {
    setTimeout(async () => {
      try {
        const points = resolveSignEndpoints().filter(x => x && x.enabled !== false && isActionSignUrl(x.url));
        if (!points.length) {
          merge.AppSign.notify = "无可执行明文动作端点（已过滤查询类学习结果）";
          return resolve();
        }
        if (!ACCOUNT.cookie && !ACCOUNT.xtoken && !ACCOUNT.phone) {
          merge.AppSign.error = 1;
          merge.AppSign.notify = "缺少会话，无法动态签到";
          return resolve();
        }

        let okN = 0, failN = 0;
        const lines = [];
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const req = buildLiveRequest(p, ACCOUNT);
          const res = await httpRaw(req.method, req.url, req.headers, req.body).catch(e => ({ error: String(e) }));
          if (res.error) {
            failN++;
            lines.push(`${p.name}: 失败 ${res.error}`);
            continue;
          }
          const text = String(res.body || "");
          const success = isBizSuccess(text, res.status);
          const already = /已签|重复|already|signed/i.test(text);
          if (success || already) {
            okN++;
            lines.push(`${p.name}: ${already ? "今日已签" : "成功"}`);
          } else {
            failN++;
            lines.push(`${p.name}: 未确认成功 HTTP ${res.status}`);
          }
          if (LogDetails) console.log(p.name, text.slice(0, 500));
          await wait(300);
        }
        if (okN) merge.AppSign.success = 1;
        if (failN && !okN) merge.AppSign.error = 1;
        merge.AppSign.notify = lines.join(" | ");
      } catch (e) {
        merge.AppSign.error = 1;
        merge.AppSign.notify = "动态端点签到异常: " + e;
      } finally {
        resolve();
      }
    }, s);
  });
}

function resolveSignEndpoints() {
  const staticPoints = Array.isArray(SignEndpoints) ? SignEndpoints.slice() : [];
  if (!AutoUseLearnedEndpoints) return staticPoints.filter(p => isActionSignUrl(p && p.url));
  if (PurgeBadLearnedEndpoints) purgeBadLearnedEndpoints();
  const learned = loadLearnedEndpoints().filter(p => isActionSignUrl(p && p.url));
  const map = {};
  staticPoints.concat(learned).forEach(p => {
    if (!p || !p.url || !isActionSignUrl(p.url)) return;
    const key = (p.method || p.type || "POST") + " " + stripDynamicQuery(p.url);
    map[key] = p;
  });
  return Object.keys(map).map(k => map[k]);
}

function loadLearnedEndpoints() {
  try {
    const raw = $nobyda.read("CMCC_SignEndpoints");
    if (!raw) return [];
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch (e) {
    return [];
  }
}

function saveLearnedEndpoints(list) {
  $nobyda.write(JSON.stringify(list || []), "CMCC_SignEndpoints");
}

function purgeBadLearnedEndpoints() {
  try {
    const list = loadLearnedEndpoints();
    const kept = list.filter(p => p && p.url && isActionSignUrl(p.url));
    if (kept.length !== list.length) {
      saveLearnedEndpoints(kept);
      console.log("purgeBadLearnedEndpoints =>", list.length - kept.length, "removed,", kept.length, "kept");
    }
  } catch (e) {}
}

// 仅动作类签到 URL 可学习/可执行；查询、登录、配置一律排除
function isActionSignUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  // 明确黑名单：本次日志里误学到的全部在这
  if (/deployenvi|sdauth|sdkauth|domain\/login|tasklist|commoninfo|markstatus|mytaskinfo|checkexclusive|appcenterfloorrule|appcentercontactinfo|getconfiguration|refreshsession|bytoken\/multi|logreport/i.test(u)) return false;
  if (/\/login|\/auth|\/token|\/config|\/status|\/info|\/list|\/query|\/detail|\/router/i.test(u) && !/do[a-z]*sign|dosign|signin|domark|receivemark|checkin/i.test(u)) return false;
  // 动作白名单
  if (/\/(doSign|signin|signIn|sign_in|checkIn|checkin|doMark|mark\/mark(?:31)?\/(?:do)?mark|receive|clockIn|dailySign)(?:\/|$|\?)/i.test(u)) return true;
  if (/qwhdhub\/api\/mark\/.*(?:doMark|doSign|sign|receive)/i.test(u)) return true;
  // 带 sign 字样但必须像动作路径，而不是 status/info
  if (/(doSign|signin|sign_in|checkIn|qiandao)/i.test(u) && !/(status|info|list|query|config|login)/i.test(u)) return true;
  return false;
}

function looksLikeSignEndpoint(url, reqBody, respBody, headers) {
  const u = String(url || "");
  if (!u) return false;
  // 只学动作接口；查询/登录一律拒绝
  if (!isActionSignUrl(u)) return false;
  // 排除纯静态/日志/监控
  if (/\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?)(\?|$)/i.test(u)) return false;
  if (/dnlog\.|logReport|collect|beacon|sensors|umeng|tingyun|hubble/i.test(u)) return false;
  // 原生密文接口（x-sign + 密文 body）不可复用
  if (/client\.app\.coc\.10086\.cn|clientaccess\.10086\.cn/i.test(u) && /x-sign|x-qen/i.test(JSON.stringify(headers || {}))) {
    return false;
  }
  if (isLikelyCipherBody(reqBody) && !looksLikePlainSignResponse(respBody)) return false;

  // 动作 URL 白名单已通过；优先在响应阶段学习（有 $response 时更可信）
  if (typeof $response === "undefined" || !$response) {
    // 请求阶段也允许学习 doMark/doSign，避免漏接口
    return /doMark|doSign|signin|checkIn|receive/i.test(u);
  }
  return true;
}

function looksLikePlainBody(body) {
  const s = String(body || "").trim();
  if (!s) return false;
  if (s[0] === "{" || s[0] === "[") return true;
  if (/=/.test(s) && /&/.test(s) && s.length < 4000) return true;
  return false;
}

function looksLikePlainSignResponse(body) {
  const s = String(body || "");
  if (!s) return false;
  if (/签到成功|今日已签|已签到|"todaySignIn"\s*:\s*true|"signed"\s*:\s*true|"code"\s*:\s*0/i.test(s)) return true;
  if (s[0] === "{" && /sign/i.test(s)) return true;
  return false;
}

function isLikelyCipherBody(body) {
  const s = String(body || "").trim();
  if (!s) return false;
  // Base64 密文特征：长串且无可读 key=value / JSON
  if (s.length > 80 && /^[A-Za-z0-9+/=]+$/.test(s) && s[0] !== "{" && s[0] !== "[") return true;
  if (s.length > 80 && !/[{}=&"]/.test(s.slice(0, 40))) return true;
  return false;
}

function learnSignEndpoint(meta) {
  const url = stripDynamicQuery(meta.url || "");
  if (!url) return null;
  const method = (meta.method || "POST").toUpperCase();
  const ct = String(getHeader(meta.headers || {}, "Content-Type") || "").toLowerCase();
  let type = "json";
  let bodyBuilder = "phoneTimeJson";
  if (method === "GET") {
    type = "get";
    bodyBuilder = "";
  } else if (/x-www-form-urlencoded/i.test(ct) || (looksLikePlainBody(meta.body) && /=/.test(meta.body || "") && (meta.body || "")[0] !== "{")) {
    type = "form";
    bodyBuilder = "phoneTimeForm";
  } else if (/json/i.test(ct) || looksLikePlainBody(meta.body)) {
    type = "json";
    // 若原始 body 是 JSON，尽量保留“键结构”，值用本次动态字段替换
    bodyBuilder = "learnedJsonKeys";
  }

  const keys = extractJsonKeys(meta.body);
  const name = guessEndpointName(url, meta.respBody || meta.body || "");
  const point = {
    name: name,
    enabled: true,
    type: type,
    method: method,
    url: url,
    builder: "learned",
    bodyBuilder: bodyBuilder || "phoneTimeJson",
    learnedKeys: keys,
    source: "auto-learn",
    updatedAt: Date.now()
  };

  const list = loadLearnedEndpoints();
  const key = method + " " + url;
  const idx = list.findIndex(x => ((x.method || (x.type === "get" ? "GET" : "POST")) + " " + stripDynamicQuery(x.url)) === key);
  let added = false;
  if (idx >= 0) {
    list[idx] = Object.assign({}, list[idx], point);
  } else {
    list.push(point);
    added = true;
  }
  // 控制数量，避免无限膨胀
  while (list.length > 20) list.shift();
  saveLearnedEndpoints(list);
  console.log("learnSignEndpoint =>", added ? "ADD" : "UPDATE", point.name, url);
  return { added: added, point: point };
}

function extractJsonKeys(body) {
  try {
    const j = JSON.parse(body || "");
    if (!j || typeof j !== "object" || Array.isArray(j)) return [];
    return Object.keys(j).slice(0, 40);
  } catch (e) {
    return [];
  }
}

function guessEndpointName(url, sample) {
  if (/签到领奖|领奖/i.test(sample + url)) return "签到领奖";
  if (/cloud|caiyun|yun\.139/i.test(url)) return "云盘签到";
  if (/doSign|signin|signIn|sign_in|checkIn/i.test(url)) return "H5签到";
  try {
    const u = new URL(url);
    return "学习:" + (u.hostname + u.pathname).slice(0, 48);
  } catch (e) {
    return "学习签到接口";
  }
}

function stripDynamicQuery(url) {
  try {
    const u = new URL(url);
    // 去掉明显一次性参数，保留业务路径
    ["_t", "t", "ts", "timestamp", "time", "nonce", "_", "r", "random", "callback"].forEach(k => u.searchParams.delete(k));
    // 对 sign 相关接口，如果 query 里仅有动态 token，仍保留 path；token 运行时用会话替换
    return u.origin + u.pathname + (u.search || "");
  } catch (e) {
    return String(url || "").replace(/([?&])(_t|t|ts|timestamp|time|nonce|_|r|random)=[^&]*/gi, "$1").replace(/[?&]$/, "");
  }
}

function shortUrl(url) {
  const s = String(url || "");
  return s.length > 90 ? s.slice(0, 87) + "..." : s;
}

function buildLiveRequest(point, account) {
  const ts = Date.now();
  const nonce = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const phone = account.phone || "";
  const method = (point.type === "get" || point.method === "GET") ? "GET" : "POST";

  // 动态 headers：永远用本次会话，不复用历史
  let headers = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": account.userAgent || "ChinaMobile/12.0.2 (iPhone; iOS 26.4.1; Scale/3.00)",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9"
  };

  if (point.builder === "appSessionHeaders" || point.builder === "learned" || !point.builder) {
    if (account.cookie) headers.Cookie = account.cookie;
    if (account.xtoken) {
      headers["x-token"] = account.xtoken;
      headers["X-Token"] = account.xtoken;
    }
    headers["x-time"] = String(ts);
    headers["x-nonce"] = nonce;
    // 注意：x-sign 无法在未知密钥下正确生成；若目标接口强制校验密文签，将失败。
  }

  let url = point.url || "";
  if (point.builder === "h5TokenQuery" || /\{token\}|\{phone\}|\{time\}/.test(url)) {
    url = url
      .replace(/\{token\}/g, encodeURIComponent(account.xtoken || account.jsessionid || ""))
      .replace(/\{phone\}/g, encodeURIComponent(phone))
      .replace(/\{time\}/g, String(ts));
  }

  // learned 接口 query 中的 time/token 类参数动态重写
  if (point.builder === "learned" && /[?&](token|accessToken|jt|jwtToken|phone|mobile)=/i.test(url)) {
    try {
      const u = new URL(url);
      ["token", "accessToken", "jt", "jwtToken"].forEach(k => {
        if (u.searchParams.has(k)) u.searchParams.set(k, account.xtoken || account.jsessionid || account.noteToken || "");
      });
      ["phone", "mobile"].forEach(k => {
        if (u.searchParams.has(k) && phone) u.searchParams.set(k, phone);
      });
      ["_t", "t", "ts", "timestamp", "time"].forEach(k => {
        if (u.searchParams.has(k)) u.searchParams.set(k, String(ts));
      });
      url = u.toString();
    } catch (e) {}
  }

  let body = null;
  if (method !== "GET") {
    if (point.bodyBuilder === "phoneTimeForm" || point.type === "form") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = `phone=${encodeURIComponent(phone)}&mobile=${encodeURIComponent(phone)}&timestamp=${ts}&client=app`;
    } else if (point.bodyBuilder === "learnedJsonKeys" && Array.isArray(point.learnedKeys) && point.learnedKeys.length) {
      headers["Content-Type"] = "application/json;charset=UTF-8";
      const obj = {};
      point.learnedKeys.forEach(k => {
        const lk = String(k).toLowerCase();
        if (/phone|mobile|msisdn|tel/.test(lk)) obj[k] = phone;
        else if (/time|timestamp|_t|ts|date/.test(lk)) obj[k] = ts;
        else if (/nonce|random/.test(lk)) obj[k] = nonce;
        else if (/token|jsession|uid/.test(lk)) obj[k] = account.xtoken || account.jsessionid || account.uid || "";
        else if (/client|channel|source|from/.test(lk)) obj[k] = /channel|source|from/.test(lk) ? "cmcc-app" : "app";
        else obj[k] = ""; // 未知字段置空，避免回放旧值
      });
      body = JSON.stringify(obj);
    } else if (point.bodyBuilder === "phoneTimeJson" || !point.bodyBuilder) {
      headers["Content-Type"] = "application/json;charset=UTF-8";
      body = JSON.stringify({
        phone: phone,
        mobile: phone,
        timestamp: ts,
        time: ts,
        client: "app",
        channel: "cmcc-app"
      });
    } else if (typeof point.bodyBuilder === "function") {
      // Node 调试可注入；QX 中请用内置 builder 名
      const built = point.bodyBuilder(account, ts, nonce);
      body = built.body;
      headers = Object.assign(headers, built.headers || {});
    } else if (point.staticBody) {
      // 明确不推荐；仅兼容测试
      body = point.staticBody;
    }
  }

  return { method, url, headers, body };
}

/********************* 通知 *********************/
function notify(tag) {
  return new Promise(resolve => {
    try {
      let ok = 0, fail = 0;
      const lines = [];
      Object.keys(merge).forEach(k => {
        const it = merge[k] || {};
        if (it.success) ok++;
        if (it.error) fail++;
        if (it.notify) lines.push(it.notify);
        if (it.bean) lines.push(`奖励: ${it.bean}`);
      });
      const title = `中国移动 · ${tag || "签到"}`;
      const subtitle = `成功${ok} / 失败${fail}`;
      const message = lines.join("\n") || "无结果";
      $nobyda.notify(title, subtitle, message);
      console.log(`\n${title}\n${subtitle}\n${message}`);
    } catch (e) {
      $nobyda.notify("中国移动", "通知异常", String(e));
    } finally {
      resolve();
    }
  });
}

/********************* 账号存储 *********************/
function loadAccounts() {
  let list = [];
  const raw = $nobyda.read("CookiesCMCC");
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) list = j;
    } catch (e) {
      console.log("CookiesCMCC 解析失败: " + e);
    }
  }
  const legacy = $nobyda.read("CookieCMCC");
  if (legacy && !list.length) list.push({ cookie: legacy });
  return checkFormat(list);
}

function saveAccounts(list) {
  $nobyda.write(JSON.stringify(checkFormat(list)), "CookiesCMCC");
}

function checkFormat(list) {
  const out = [];
  const seen = new Set();
  (list || []).forEach(item => {
    if (!item || typeof item !== "object") return;
    const n = normalizeAccount(item);
    // 丢掉纯伪号幽灵账号
    if (n.phone && !isValidPhone(n.phone)) n.phone = "";
    if (!n.phone && !n.uid && !n.jsessionid && !n.cloudAuthorization && !n.h5Cookie) return;
    const key = n.phone || n.uid || n.jsessionid || ("cloud:" + (n.cloudAuthorization || "").slice(-12));
    if (!key || seen.has(key)) {
      if (key && seen.has(key)) {
        const idx = out.findIndex(x =>
          (n.phone && x.phone === n.phone) ||
          (n.uid && x.uid === n.uid) ||
          (n.jsessionid && x.jsessionid === n.jsessionid)
        );
        if (idx >= 0) out[idx] = mergeAccount(out[idx], n);
      }
      return;
    }
    seen.add(key);
    out.push(n);
  });
  return out;
}

function normalizeAccount(item) {
  const o = Object.assign({}, item || {});
  o.phone = sanitizePhone(o.phone);
  o.jsessionid = o.jsessionid || matchOne(o.cookie || "", /JSESSIONID=([^;]+)/i);
  o.uid = o.uid || matchOne(o.cookie || "", /UID=([^;]+)/i);
  // 明确丢弃旧版固化 tasks，避免被误用
  if (o.tasks) delete o.tasks;
  // 非法伪号码清空，防止 140****6052 这类时间戳残骸
  if (o.phone && !isValidPhone(o.phone)) o.phone = "";
  return o;
}

function mergeAccount(oldItem, neo) {
  const o = Object.assign({}, oldItem);
  [
    "phone", "cookie", "jsessionid", "uid", "xtoken", "userAgent",
    "cloudAuthorization", "noteToken", "appNumber", "cloudUA",
    "h5Cookie", "h5Token", "source"
  ].forEach(k => { if (neo[k]) o[k] = neo[k]; });
  // 只有合法手机号才覆盖，避免错误号把正确号冲掉
  if (neo.phone && isValidPhone(neo.phone)) o.phone = neo.phone;
  o.updatedAt = neo.updatedAt || Date.now();
  if (o.tasks) delete o.tasks;
  if (o.phone && !isValidPhone(o.phone)) o.phone = oldItem.phone || "";
  return o;
}

function upsertAccount(item, silent) {
  const list = loadAccounts().filter(a => {
    // 启动时顺带清洗伪号码账号
    if (a && a.phone && !isValidPhone(a.phone) && !a.uid && !a.jsessionid) return false;
    return true;
  });
  const n = normalizeAccount(item);
  // 完全没有身份字段则不入库，避免制造幽灵账号
  if (!n.phone && !n.uid && !n.jsessionid && !n.cloudAuthorization && !n.h5Cookie) {
    return n;
  }
  let idx = -1;
  if (n.phone) idx = list.findIndex(x => x.phone && x.phone === n.phone);
  if (idx < 0 && n.uid) idx = list.findIndex(x => x.uid && x.uid === n.uid);
  if (idx < 0 && n.jsessionid) idx = list.findIndex(x => x.jsessionid && x.jsessionid === n.jsessionid);
  if (idx >= 0) list[idx] = mergeAccount(list[idx], n);
  else {
    // 无合法 phone 时，不要新建“假号”账号（除非有 session）
    if (!n.phone && !n.uid && !n.jsessionid) return n;
    list.push(n);
    idx = list.length - 1;
  }
  saveAccounts(list);
  if (!silent) console.log("account upsert =>", maskPhone(list[idx].phone || list[idx].uid || ""));
  return list[idx];
}

function findAccountByPhone(phone) {
  const p = sanitizePhone(phone);
  if (!isValidPhone(p)) return null;
  return loadAccounts().find(a => a.phone === p) || null;
}

/********************* HTTP 封装 *********************/
function httpJson(method, url, headers, data) {
  return httpRaw(method, url, headers, data == null ? null : JSON.stringify(data)).then(r => {
    if (r.error) throw new Error(r.error);
    if (!r.body) return {};
    try { return JSON.parse(r.body); } catch (e) { return { raw: r.body, status: r.status }; }
  });
}

function httpRaw(method, url, headers, body) {
  return new Promise(resolve => {
    const m = (method || "GET").toUpperCase();
    const opts = { url: url, headers: headers || {} };
    if (m !== "GET" && body != null) opts.body = body;

    let finished = false;
    const finish = (v) => { if (!finished) { finished = true; resolve(v); } };
    const timer = setTimeout(() => finish({ error: "timeout", status: 0, body: "" }), out);

    const cb = (error, response, data) => {
      clearTimeout(timer);
      if (error) return finish({ error: String(error), status: 0, body: "" });
      const status = response ? (response.status || response.statusCode || 0) : 0;
      finish({ status: status, body: data || "", error: null });
    };

    if (m === "GET") $nobyda.get(opts, cb);
    else $nobyda.post(opts, cb);
  });
}

/********************* 工具 *********************/
function isBizSuccess(text, status) {
  if (/rtnCode"?\s*[:=]\s*"?0+\b/i.test(text)) return true;
  if (/"code"\s*:\s*0\b/i.test(text)) return true;
  if (/"success"\s*:\s*true/i.test(text)) return true;
  if (/签到成功|领取成功|"msg"\s*:\s*"success"/i.test(text)) return true;
  if (status >= 200 && status < 300 && /已签|already/i.test(text)) return true;
  return false;
}

function extractReward(text) {
  const m = String(text).match(/(?:奖励|积分|金币|云朵|流量|bean|prize)[^\d]{0,10}(\d+(?:\.\d+)?)/i);
  return m ? m[1] : "";
}

function normalizeHeaders(h) {
  const o = {};
  Object.keys(h || {}).forEach(k => o[k] = h[k]);
  return o;
}

function getHeader(headers, name) {
  if (!headers) return "";
  if (headers[name] != null) return headers[name];
  const key = Object.keys(headers).find(k => String(k).toLowerCase() === String(name).toLowerCase());
  return key ? headers[key] : "";
}

function pickSessionCookie(raw) {
  if (!raw) return "";
  const text = Array.isArray(raw) ? raw.join(";") : String(raw);
  const jsid = matchOne(text, /JSESSIONID=([^;,\s]+)/i);
  const uid = matchOne(text, /UID=([^;,\s]+)/i);
  if (!jsid) return "";
  let c = `JSESSIONID=${jsid}`;
  if (uid) c += `; UID=${uid}`;
  if (/ticketID=POD9/i.test(text)) c += `; Comment=SessionServer-unity; Path=/;HTTPOnly; ticketID=POD9; Secure`;
  return c;
}

function extractPhoneLoose() {
  // 兼容旧调用；内部改走严格规则
  return extractPhoneStrict.apply(null, arguments);
}

// 严格提取手机号：优先字段语义，过滤时间戳伪号
function extractPhoneStrict() {
  const parts = Array.prototype.slice.call(arguments).map(x => {
    try { return typeof x === "string" ? x : JSON.stringify(x); } catch (e) { return String(x); }
  });
  const blob = parts.join("\n");

  // 1) 字段语义优先
  const named = [
    /(?:phone|mobile|msisdn|tel|app_number|appNumber)["'=\s:]*?(1[3-9]\d{9})/ig,
    /mobile:(1[3-9]\d{9})/ig
  ];
  for (let i = 0; i < named.length; i++) {
    let m;
    const re = named[i];
    while ((m = re.exec(blob))) {
      const p = sanitizePhone(m[1]);
      if (isValidPhone(p)) return p;
    }
  }

  // 2) Basic 解码
  const basic = blob.match(/Basic\s+([A-Za-z0-9+/=]+)/i);
  if (basic) {
    const p = decodeBasicPhone("Basic " + basic[1]);
    if (p) return p;
  }

  // 3) 裸 11 位兜底，但必须通过有效号段校验，且不能落在 URL 时间戳附近
  const all = blob.match(/1[3-9]\d{9}/g) || [];
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    if (!isValidPhone(p)) continue;
    // 排除 query currentTime=17865... 这类拼接
    const idx = blob.indexOf(p);
    const around = blob.slice(Math.max(0, idx - 24), idx + 20).toLowerCase();
    if (/time|timestamp|currenttime|nonce|token|_t=|date|expires|expire/.test(around)) continue;
    return p;
  }
  return "";
}

function sanitizePhone(v) {
  return String(v || "").replace(/\D/g, "");
}

function isValidPhone(v) {
  const p = sanitizePhone(v);
  if (!/^1[3-9]\d{9}$/.test(p)) return false;
  // 拒绝 140-144 等非号段（时间戳/内部 ID 常见）
  if (/^14[0-4]/.test(p)) return false;
  // 日志假号：17864/17865... 来自 Date.now() 前 11 位
  if (/^1786[0-9]\d{6}$/.test(p)) return false;
  if (/^(\d)\1{10}$/.test(p)) return false;
  return true;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(String(s || "")); } catch (e) { return String(s || ""); }
}

function mergeCookieString(a, b) {
  const map = {};
  const push = (raw) => {
    String(raw || "").split(/,(?=[^;]+?=)|;/).forEach(part => {
      const s = String(part || "").trim();
      if (!s || /=/.test(s) === false) return;
      // 跳过 Set-Cookie 属性
      if (/^(path|domain|expires|max-age|secure|httponly|samesite)=/i.test(s)) return;
      if (/^(secure|httponly|samesite)$/i.test(s)) return;
      const i = s.indexOf("=");
      if (i <= 0) return;
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      if (!k) return;
      map[k] = v;
    });
  };
  // Set-Cookie 可能多段，用宽松切分
  const norm = (raw) => {
    if (!raw) return "";
    if (Array.isArray(raw)) return raw.join(";");
    // 多个 Set-Cookie 用逗号拼接时，尽量保留 name=value
    return String(raw).replace(/Expires=[^;,]*,/gi, "Expires=,").replace(/expires=[^;,]*,/gi, "expires=,");
  };
  push(norm(a));
  push(norm(b));
  return Object.keys(map).map(k => k + "=" + map[k]).join("; ");
}

function decodeBasicPhone(auth) {
  try {
    const m = String(auth).match(/Basic\s+([A-Za-z0-9+/=]+)/i);
    if (!m) return "";
    const dec = base64Decode(m[1]);
    // Basic 常见 mobile:138....:token
    const named = dec.match(/mobile[:|=](1[3-9]\d{9})/i);
    if (named && isValidPhone(named[1])) return named[1];
    const p = dec.match(/1[3-9]\d{9}/);
    return p && isValidPhone(p[0]) ? p[0] : "";
  } catch (e) { return ""; }
}

function maskPhone(v) {
  const s = String(v || "");
  if (/^1\d{10}$/.test(s)) return s.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
  if (s.length > 10) return s.slice(0, 4) + "***" + s.slice(-4);
  return s || "未知";
}

function matchOne(text, re) {
  const m = String(text || "").match(re);
  return m ? m[1] : "";
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function base64Decode(input) {
  if (typeof Buffer !== "undefined") return Buffer.from(input, "base64").toString("utf8");
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let str = String(input).replace(/=+$/, "");
  let output = "";
  for (let bc = 0, bs, buffer, idx = 0; (buffer = str.charAt(idx++)); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
    buffer = chars.indexOf(buffer);
  }
  try { return decodeURIComponent(escape(output)); } catch (e) { return output; }
}

/********************* nobyda 适配层 *********************/
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
    if (!isNode) return null;
    return { request: require("request"), fs: require("fs"), path: require("path") };
  })();

  const notify = (title, subtitle, message, rawopts) => {
    console.log(`${title}\n${subtitle}\n${message}`);
    if (isQuanX) $notify(title, subtitle, message, rawopts);
    if (isSurge) $notification.post(title, subtitle, message, rawopts);
    if (isLoon) $notification.post(title, subtitle, message, rawopts);
    if (isNode) {
      try {
        const p = node.path.join(__dirname, "sendNotify.js");
        if (node.fs.existsSync(p)) require(p).sendNotify(title + "\n" + subtitle, message);
      } catch (e) {}
    }
  };

  const write = (value, key) => {
    if (isQuanX) return $prefs.setValueForKey(value, key);
    if (isSurge || isLoon) return $persistentStore.write(value, key);
    if (isNode) {
      try {
        if (!node.fs.existsSync(NodeSet)) node.fs.writeFileSync(NodeSet, JSON.stringify({}));
        const data = JSON.parse(node.fs.readFileSync(NodeSet));
        if (value === "") delete data[key]; else data[key] = value;
        node.fs.writeFileSync(NodeSet, JSON.stringify(data, null, 2));
        return true;
      } catch (e) { return false; }
    }
  };

  const read = (key) => {
    if (isQuanX) return $prefs.valueForKey(key);
    if (isSurge || isLoon) return $persistentStore.read(key);
    if (isNode) {
      try {
        if (!node.fs.existsSync(NodeSet)) return "";
        const data = JSON.parse(node.fs.readFileSync(NodeSet));
        return data[key] || "";
      } catch (e) { return ""; }
    }
  };

  const adapterStatus = (response) => {
    if (response) {
      if (response.status) response.statusCode = response.status;
      else if (response.statusCode) response.status = response.statusCode;
    }
    return response;
  };

  const get = (options, callback) => {
    if (isQuanX) {
      if (typeof options === "string") options = { url: options };
      options.method = "GET";
      $task.fetch(options).then(r => callback(null, adapterStatus(r), r.body), e => callback(e.error, null, null));
    }
    if (isSurge || isLoon) $httpClient.get(options, (e, r, b) => callback(e, adapterStatus(r), b));
    if (isNode) node.request(options, (e, r, b) => callback(e, adapterStatus(r), b));
  };

  const post = (options, callback) => {
    if (isQuanX) {
      if (typeof options === "string") options = { url: options };
      options.method = "POST";
      $task.fetch(options).then(r => callback(null, adapterStatus(r), r.body), e => callback(e.error, null, null));
    }
    if (isSurge || isLoon) $httpClient.post(options, (e, r, b) => callback(e, adapterStatus(r), b));
    if (isNode) node.request.post(options, (e, r, b) => callback(e, adapterStatus(r), b));
  };

  const time = () => console.log("\n耗时: " + ((Date.now() - start) / 1000).toFixed(2) + " 秒");
  const done = (value = {}) => {
    if (isQuanX) return $done(value);
    if (isSurge || isLoon) return isRequest ? $done(value) : $done();
  };

  return { isRequest, isSurge, isQuanX, isLoon, isNode, notify, write, read, get, post, time, done };
}
