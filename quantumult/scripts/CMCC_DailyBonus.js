/*************************

  中国移动 App · 登录后即时签到
  语法风格参考 NobyDa/JD_DailyBonus.js
  适用：Quantumult X / Surge / Loon / Node.js

  设计原则：
  - 不固化、不回放历史签到报文
  - 每次登录成功后，用「本次」会话/凭证，现场动态拼装参数并发起签到
  - 定时任务也会对已保存会话做「现场签到」

  主路径（2026-08-13 抓包证实）：
  1) fingerprintLogin → JSESSIONID/UID
  2) GET qwhdmark/{activityId} → 302 qwhdsso/login?sid=QWHDSSO...
  3) POST qwhdsso/appTokenLogin?sid=...
       body.token = "JSESSIONID=...; UID=...; ... ticketID=..."
  4) GET 返回 data.url（带 token=QWHDSSO...）→ Set-Cookie: QWHD_SESSION_TOKEN=...
  5) POST /qwhdhub/api/mark/mark31/markstatus  Cookie=QWHD_SESSION_TOKEN + login-check:1
  6) POST /qwhdhub/api/mark/mark31/domark  body={"date":"yyyyMMdd"}
  7) 可选：POST /mark31/taskAward/{id} 领取累计任务奖

  云盘签到主路径（2026-08-13 抓包 + 打开即签）：
  1) 打开移动云盘 → getUser 带 Authorization Basic mobile:手机号:...
  2) 脚本自行 POST user-njs.yun.139.com/user/querySpecTokenV2 {"toSourceId":"001005"} → YZsid...
  3) POST m.mcloud.139.com/ycloud/auth-service/auth/tyrzLogin
       {token, openAccount:0, marketName:sign_in_3, sourceId:1002} → jwtToken
  4) GET m.mcloud.139.com/ycloud/signin/page/startSignIn?client=app → 今日豆/连签
  约束：每日每号成功一次（CloudDailyOnce）；不必进签到页；getUser 触发

限制：
  - 原生 biz-orange 业务是 x-sign + 密文 body，无法伪造
  - 无 QWHD_SESSION_TOKEN 时直接打 mark API 会 302 → /qwhdhub/notice/404
  - 旧云盘 host caiyun.feixin.10086.cn/market/* 多环境 request not found，已弃用

*************************/

var $nobyda = nobyda();

/********************* 可配置区 *********************/
var LogDetails = false;
var DeleteCookie = false;
var out = 15000; // 单请求超时(ms)
// 登录成功后是否立刻自动签到（核心开关）
var AutoSignAfterLogin = true;
// 登录后延迟多久开始签到，给 H5/云盘子请求一点落库时间
var SignDelayMs = 1800;
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
// 是否尝试移动云盘签到（ycloud startSignIn；抓包 2026-08-13 证实有效）
var EnableCloudSign = true;
// 打开移动云盘后：是否允许云盘自动签到链路（含通知）
var AutoCloudSignOnAuth = true;
// 打开云盘（捕获 getUser Basic）时：脚本自行 LiveCloudSign（querySpec→tyrz→startSignIn）
// 目标：不必进「签到页」；自签优先用脚本新换的 SSO，不抢 App 已持有的一次性票
var AutoCloudLiveSignOnOpen = true;
// 每日每号只自签成功一次（打开多次 / rewrite 并发 / 签到页观测 都共享此锁）
var CloudDailyOnce = true;
// 软跳过（SSO/tyrz 失败）是否弹通知：默认 false（打开自签失败会单独 NotifyCloudOpenFail）
var NotifyCloudSoftSkip = false;
// 打开自签失败（tyrz/SSO）是否弹一次通知，便于定位「打开没签上」
var NotifyCloudOpenFail = true;
// 云盘结果通知防抖（ms）
var CloudAutoDebounceMs = 120000;
// 打开自签进行中硬锁（ms），防 getUser 连发双签
var CloudOpenInflightMs = 45000;
// Basic 写入节流：同一 Basic 尾缀 60s 内不重复 upsert（防刷盘+刷日志）
var CloudBasicWriteThrottleMs = 60000;
// 云盘活动参数（抓包固定值，非历史 body 回放）
var CloudMarketName = "sign_in_3";
var CloudSourceId = "1002";
var CloudTargetSourceId = "001005"; // newsignin / startSignIn 对应 targetSourceId
var CloudTargetSourceIdAlt = "001003"; // 仅作 querySpec 兜底，不优先
// 是否允许从任意文本裸扫 11 位号（极易把 CDN 图链数字当手机号，默认关）
var AllowBarePhoneFallback = false;
// 是否自动领取 domark 返回的 taskAwardChance
var AutoClaimTaskAward = true;
// 签到领奖活动页（抓包：qwhdmark/1021122301）
var QwhdActivityId = "1021122301";
var QwhdChannelId = "P00000057578";
var QwhdYx = "9000303382";
// 默认省/市码（若账号未捕获，用此兜底；湖南移动常见 731/2731）
var DefaultProvinceCode = "731";
var DefaultCityCode = "2731";
var DefaultCarrierOperator = "002";

/********************* 运行时 *********************/
var merge = {};
var ACCOUNT = null;

ReadCookie();

/********************* 入口 *********************/
function ReadCookie() {
  if (DeleteCookie) {
    $nobyda.write("", "CookiesCMCC");
    $nobyda.write("", "CookieCMCC");
    $nobyda.write("", "CMCC_SignEndpoints");
    $nobyda.write("", "CMCC_CloudAutoAt");
    $nobyda.write("", "CMCC_CloudNotifySig");
    $nobyda.write("", "CMCC_CloudAutoKey");
    $nobyda.write("", "CMCC_CloudSignedDayMap");
    $nobyda.write("", "CMCC_CloudSignedDay");
    $nobyda.write("", "CMCC_CloudOpenInflight");
    $nobyda.notify("中国移动", "", "已清空 CookiesCMCC / CookieCMCC / CMCC_SignEndpoints / 云盘防抖与每日锁");
    return $nobyda.done();
  }

  if ($nobyda.isRequest) {
    // rewrite/mitm 捕获路径：可能同步触发登录后签到
    // QX response 脚本必须透传 body，否则 Content-Length 与 body 不一致报错
    // 注意：response 脚本有硬超时，登录后自动签到尽量轻量
    GetCookie().then(() => finishRequest()).catch(e => {
      console.log("GetCookie error: " + e);
      finishRequest();
    });
    return;
  }

  if (PurgeBadLearnedEndpoints) purgeBadLearnedEndpoints();
  // 每次 cron 自洁幽灵号（CDN 图链截出来的 11 位）
  purgeGhostAccounts();

  // cron / 手动运行：仅跑「可签」账号，避免 165/133 等幽灵号刷屏
  const list = loadAccounts().filter(isRunnableAccount);
  if (!list.length) {
    $nobyda.notify("中国移动", "", "无可用账号。请先登录中国移动 App（签到领奖）或打开移动云盘（云盘签到）。");
    return $nobyda.done();
  }

  (async () => {
    console.log("cron runnable accounts =>", list.length, list.map(a => maskPhone(a.phone || a.uid || "?")).join(", "));
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
  // 登录触发：延迟后再读一次，合并同号 cloud/H5 会话
  if (opts && opts.reason === "login-trigger") {
    const fresh = reloadAccount(ACCOUNT);
    if (fresh) ACCOUNT = fresh;
  }
  merge = {};
  $nobyda.time();

  const tag = maskPhone(ACCOUNT.phone || ACCOUNT.uid || "未知");
  console.log(`\n==== 账号 ${tag} / 原因 ${opts && opts.reason || "manual"} ====`);

  // 主路径：签到领奖(qwhdhub)；辅路径：移动云盘 ycloud / 已学习动作端点
  // 有 App 会话才跑 Qwhd；纯云盘账号只跑云盘
  const hasAppSession = !!(ACCOUNT.jsessionid || (ACCOUNT.cookie && /JSESSIONID=/i.test(ACCOUNT.cookie)));
  if (hasAppSession) {
    await LiveQwhdSign(0);
    const again = reloadAccount(ACCOUNT);
    if (again) ACCOUNT = again;
  } else {
    merge.QwhdSign = { notify: "" };
  }

  const jobs = [];
  if (EnableCloudSign && (ACCOUNT.cloudAuthorization || ACCOUNT.cloudSsoToken || ACCOUNT.cloudJwt)) {
    jobs.push(LiveCloudSign(0));
  } else if (EnableCloudSign) {
    merge.CloudSign = { notify: hasAppSession ? "跳过云盘：无云盘凭证（打开一次移动云盘即可捕获）" : "跳过云盘：无云盘凭证" };
  } else {
    merge.CloudSign = { notify: "" };
  }
  // 已有 Qwhd 主路径成功时，不必再靠 learned 端点补枪
  if (hasAppSession && !(merge.QwhdSign && merge.QwhdSign.success)) jobs.push(LiveEndpointSign(0));
  else merge.AppSign = { notify: "" };
  if (jobs.length) await Promise.all(jobs);

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
  // 硬白名单：未配置到 conf 的多余请求（历史宽规则残留）直接透传
  if (!isInterestingCaptureUrl(url)) return;

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
      ticketId: matchOne(setCookie + ";" + cookie, /ticketID=([^;,\s]+)/i) || "",
      xtoken: getHeader(headers, "x-token") || getHeader(headers, "X-Token") || "",
      userAgent: getHeader(headers, "User-Agent") || "ChinaMobile/12.0.2 (iPhone; iOS 26.4.1; Scale/3.00)",
      appVersion: matchOne(getHeader(headers, "User-Agent") || "", /ChinaMobile\/([\d.]+)/i) || "12.0.2",
      updatedAt: Date.now(),
      source: "fingerprintLogin"
    };

    const saved = upsertAccount(acc);
    const label = maskPhone(saved.phone || saved.uid || "账号");
    $nobyda.notify(
      "中国移动",
      "登录会话已更新",
      label + (saved.phone ? "" : "（指纹登录密文，无明文手机号属正常；H5 仍可签）")
    );

    if (AutoSignAfterLogin) {
      // 关键：必须在 finishRequest/$done 之前尽量跑完，但 rewrite-response 有硬超时。
      // 策略：短延迟 + 主路径优先；超时会被 QX 杀掉（见日志 Exception timeout）。
      const delay = Math.min(SignDelayMs || 0, 900);
      if (delay > 0) await wait(delay);
      const latest = reloadAccount(saved) || saved;
      await all(latest, { reason: "login-trigger" });
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

  // 2.5) 签到 H5 会话（qwhdhub / qwhdsso）—— 保存 QWHD_SESSION_TOKEN / token / SSO jwt
  if (/wx\.10086\.cn\/(?:qwhdhub|qwhdsso)\//i.test(url)) {
    const setCookie = getHeader(respHeaders, "Set-Cookie") || "";
    const reqCookie = getHeader(headers, "Cookie") || "";
    const h5Cookie = mergeCookieString(reqCookie, setCookie);
    const qwhdSession =
      matchOne(h5Cookie, /QWHD_SESSION_TOKEN=([^;]+)/i) ||
      matchOne(setCookie, /QWHD_SESSION_TOKEN=([^;]+)/i) ||
      "";
    const phone = extractPhoneStrict(body, respBody, headers, reqCookie, setCookie, url);
    const h5Token =
      matchOne(url, /[?&](?:token|accessToken|jt)=([^&]+)/i) ||
      matchOne(String(body || ""), /"(?:token|accessToken|jt)"\s*:\s*"([^"]+)"/i) ||
      matchOne(String(respBody || ""), /"loginUid"\s*:\s*"(QWHDSSO[^"]+)"/i) ||
      "";
    const ssoJwt =
      matchOne(String(respBody || ""), /"jwt"\s*:\s*"([^"]+)"/i) || "";
    const nickPhone = matchOne(String(respBody || ""), /"nickName"\s*:\s*"(1\d{2})\*{4}(\d{4})"/i);
    // appTokenLogin / 页面 Referer 里可能有省市区
    let provinceCode = matchOne(String(body || ""), /"provinceCode"\s*:\s*"?(\d+)"?/i);
    let cityCode = matchOne(String(body || ""), /"cityCode"\s*:\s*"?(\d+)"?/i);
    let activityId =
      matchOne(url, /qwhdmark\/(\d+)/i) ||
      matchOne(url, /activityId=(\d+)/i) ||
      matchOne(String(respBody || ""), /"activityId"\s*:\s*"(\d+)"/i) ||
      "";

    // appTokenLogin 请求体会带 JSESSIONID；可反绑手机对应账号
    const jsidInBody = matchOne(String(body || ""), /JSESSIONID=([^;"\s]+)/i);
    const patch = {
      phone: phone,
      h5Cookie: h5Cookie,
      h5Token: decodeURIComponentSafe(h5Token),
      qwhdSession: qwhdSession,
      ssoJwt: ssoJwt,
      provinceCode: provinceCode,
      cityCode: cityCode,
      activityId: activityId,
      userAgent: getHeader(headers, "User-Agent") || "",
      updatedAt: Date.now(),
      source: /appTokenLogin/i.test(url) ? "qwhdsso-login" : "qwhdhub-session"
    };
    // 从 nickName 138****1269 无法直接得全号；但 UUID 里有真实号时可用
    const phoneInUuid = matchOne(String(respBody || ""), /AvnWN(1[3-9]\d{9})/i);
    if (!patch.phone && phoneInUuid && isValidPhone(phoneInUuid)) patch.phone = phoneInUuid;
    if (jsidInBody) patch.jsessionid = jsidInBody;
    if (h5Cookie || phone || h5Token || qwhdSession || jsidInBody) {
      upsertAccount(patch, true);
    }
  }

  // 2.6) 专门捕获 appTokenLogin 响应里的跳转 token / jwt
  if (/wx\.10086\.cn\/qwhdsso\/appTokenLogin/i.test(url) && $response) {
    try {
      const j = JSON.parse(respBody || "{}");
      const data = (j && j.data) || {};
      const jump = data.url || "";
      const token = matchOne(jump, /[?&]token=([^&]+)/i) || "";
      const jsid = matchOne(String(body || ""), /JSESSIONID=([^;"\s]+)/i);
      const uid = matchOne(String(body || ""), /UID=([^;"\s]+)/i);
      const phone = extractPhoneStrict(body, respBody);
      upsertAccount({
        phone: phone,
        jsessionid: jsid,
        uid: uid,
        h5Token: decodeURIComponentSafe(token),
        ssoJwt: data.jwt || "",
        provinceCode: matchOne(String(body || ""), /"provinceCode"\s*:\s*"?(\d+)"?/i),
        cityCode: matchOne(String(body || ""), /"cityCode"\s*:\s*"?(\d+)"?/i),
        activityId: matchOne(jump, /qwhdmark\/(\d+)/i) || QwhdActivityId,
        cookie: jsid ? (`JSESSIONID=${jsid}` + (uid ? `; UID=${uid}` : "")) : "",
        updatedAt: Date.now(),
        source: "appTokenLogin"
      }, true);
    } catch (e) {}
  }

  // 3) 云盘轻量捕获（仅 conf 中列出的少数 URL 会进来）
  //    绝对禁止打开时 LiveCloudSign / tyrz 自打（防 rewrite timeout）
  if (isCloudCaptureUrl(url)) {
    await captureCloudTraffic(url, headers, body, respBody, !!$response);
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

/********************* 云盘流量捕获（极轻量） *********************/
function isInterestingCaptureUrl(url) {
  const u = String(url || "");
  if (/fingerprintLogin|qwhdsso\/appTokenLogin|qwhdhub\/qwhdmark|qwhdhub\/api\/mark\/mark31\/(domark|markstatus|taskAward)/i.test(u)) return true;
  if (/client\.app\.coc\.10086\.cn\/biz-orange\//i.test(u)) return true;
  if (isCloudCaptureUrl(u)) return true;
  // 学习动作类：仅 10086 域名且像动作
  if (/10086\.cn/i.test(u) && isActionSignUrl(u)) return true;
  return false;
}

function isCloudCaptureUrl(url) {
  const u = String(url || "");
  // 刻意不再匹配 querySpec/tyrz/portal：脚本自签发出的请求若被 rewrite 二次拦截会超时/乱签
  return /user(?:-njs)?\.yun\.139\.com\/user\/getUser/i.test(u) ||
    /m\.mcloud\.139\.com\/ycloud\/signin\/page\/startSignIn/i.test(u);
}

async function captureCloudTraffic(url, headers, body, respBody, hasResp) {
  const auth = getHeader(headers, "Authorization") || getHeader(headers, "APP_AUTH") || "";
  const uaHdr = getHeader(headers, "User-Agent") || "";
  const deviceHdr = getHeader(headers, "deviceId") || "";
  const ref = getHeader(headers, "Referer") || "";
  let saved = null;

  // Basic：仅 getUser（打开云盘）。不再 hook querySpec/tyrz——避免脚本自签 HTTP 嵌套进 rewrite 导致超时/失败
  if (/Basic\s+/i.test(auth) && /user(?:-njs)?\.yun\.139\.com\/user\/getUser/i.test(url)) {
    const phone = decodeBasicPhone(auth);
    if (isValidPhone(phone)) {
      if (shouldWriteCloudBasic(auth)) {
        saved = upsertAccount({
          phone: phone,
          cloudAuthorization: auth,
          noteToken: getHeader(headers, "NOTE_TOKEN") || "",
          appNumber: getHeader(headers, "APP_NUMBER") || "",
          cloudUA: uaHdr,
          cloudDeviceId: deviceHdr || undefined,
          updatedAt: Date.now(),
          source: "cloud-auth"
        }, true);
        rememberCloudBasic(auth);
      } else {
        saved = normalizeAccount(Object.assign({}, findAccountByPhone(phone) || {}, {
          phone: phone,
          cloudAuthorization: auth,
          cloudUA: uaHdr || undefined,
          cloudDeviceId: deviceHdr || undefined
        }));
      }
      // request：只存 Basic，不重签（rewrite-request 硬超时太短，3 并发 querySpec 会半途死亡）
      // response：才 LiveCloudSign（超时余量更大，且与 App 侧 getUser 完成同步）
      if (!hasResp) return;
      await tryCloudAutoSignOnOpen({
        phone: phone,
        cloudAuthorization: auth,
        cloudUA: uaHdr,
        cloudDeviceId: deviceHdr,
        noteToken: getHeader(headers, "NOTE_TOKEN") || "",
        appNumber: getHeader(headers, "APP_NUMBER") || "",
        fromResp: true
      });
    }
    return;
  }

  // startSignIn 响应：仅兜底观测（App 自己签时）；不挂 request，减少嵌套
  if (/startSignIn/i.test(url) && hasResp && respBody) {
    const jwtHdr = getHeader(headers, "jwtToken") || matchOne(getHeader(headers, "Cookie") || "", /jwtToken=([^;]+)/i) || "";
    const phoneHint = resolveRecentCloudPhone();
    if (jwtHdr) {
      saved = upsertCloudSession({
        phone: phoneHint,
        cloudJwt: jwtHdr,
        cloudUA: uaHdr,
        cloudDeviceId: deviceHdr || undefined,
        source: "cloud-startSignIn-resp"
      });
    }
    if (!(EnableCloudSign && AutoCloudSignOnAuth)) return;
    const parsed = parseCloudStartSignInBody(respBody);
    if (!(parsed && parsed.ok)) return;
    const acc = normalizeAccount(reloadAccount(saved) || saved || { phone: phoneHint });
    if (!isValidPhone(acc.phone) && isValidPhone(phoneHint)) acc.phone = phoneHint;
    if (isValidPhone(acc.phone)) markCloudDoneToday(acc.phone, parsed);
    if (!claimCloudAutoNotify(acc, parsed)) return;
    merge = {};
    merge.CloudSign = {
      success: 1,
      notify: parsed.already
        ? ("云盘: 今日已签到" + (parsed.points != null ? ` · ${parsed.points}豆` : ""))
        : ("云盘: 签到成功" + (parsed.points != null ? ` · +${parsed.points}豆` : "")),
      bean: parsed.points != null ? (parsed.points + "豆") : ""
    };
    if (parsed.signCount != null) merge.CloudSign.notify += ` · 连签${parsed.signCount}天`;
    ACCOUNT = acc;
    await notify(maskPhone(ACCOUNT.phone || "云盘") + "·云盘");
  }
}

/**
 * 打开云盘（getUser）→ 自行 LiveCloudSign 一次。
 * - 不要求进入签到页
 * - 每日每号成功仅一次；失败可再次打开重试
 * - 自签使用脚本新申请的 SSO，不消费 App 已拿到的 querySpec 票
 */
async function tryCloudAutoSignOnOpen(seed) {
  if (!(EnableCloudSign && AutoCloudSignOnAuth && AutoCloudLiveSignOnOpen)) return;
  const phone = seed && isValidPhone(seed.phone) ? seed.phone : "";
  if (!phone) return;
  if (!(seed.cloudAuthorization && /Basic\s+/i.test(seed.cloudAuthorization))) return;
  if (CloudDailyOnce && isCloudDoneToday(phone)) {
    // 今日已成功：静默（最多再靠签到页观测补历史，不在此弹）
    clog("cloud open skip: done today " + maskPhone(phone));
    return;
  }
  // 并发 getUser：CAS 互斥（先写锁 → 短等 → 复核），避免 3 路同时 querySpec
  if (!(await claimCloudOpenInflightCas(phone))) {
    clog("cloud open skip: inflight " + maskPhone(phone));
    return;
  }
  clog("cloud open sign start " + maskPhone(phone) + " " + (seed.fromResp ? "resp" : "req"));
  try {
    const base = findAccountByPhone(phone) || {};
    const acc = normalizeAccount(Object.assign({}, base, {
      phone: phone,
      cloudAuthorization: seed.cloudAuthorization,
      cloudUA: seed.cloudUA || base.cloudUA || "",
      cloudDeviceId: seed.cloudDeviceId || base.cloudDeviceId || "",
      noteToken: seed.noteToken || base.noteToken || "",
      appNumber: seed.appNumber || base.appNumber || "",
      // 打开自签强制现换 SSO/jwt
      cloudJwt: "",
      cloudSsoToken: "",
      updatedAt: Date.now(),
      source: "cloud-open-auto"
    }));
    upsertAccount({
      phone: acc.phone,
      cloudAuthorization: acc.cloudAuthorization,
      cloudUA: acc.cloudUA,
      cloudDeviceId: acc.cloudDeviceId || undefined,
      noteToken: acc.noteToken || "",
      appNumber: acc.appNumber || "",
      cloudJwt: "",
      cloudSsoToken: "",
      updatedAt: Date.now(),
      source: "cloud-open-auto"
    }, true);

    ACCOUNT = acc;
    merge = {};
    // open 模式：单次 querySpec(njs+001005)→tyrz→startSignIn
    await LiveCloudSign(0, { openOnce: true });
    const cs = merge.CloudSign || {};
    if (cs.success) {
      const pseudo = cloudNotifyPseudoFromMerge(cs);
      markCloudDoneToday(phone, pseudo);
      if (!claimCloudAutoNotify(ACCOUNT, pseudo)) {
        clog("cloud open success but notify deduped " + maskPhone(phone));
        return;
      }
      await notify(maskPhone(ACCOUNT.phone || phone) + "·云盘");
      clog("cloud open sign ok " + maskPhone(phone) + " " + (cs.notify || ""));
      return;
    }
    // 失败 / 软跳过：打日志；打开场景默认可弹一次失败原因
    clog("cloud open sign fail => " + (cs.notify || cs.error || "unknown"));
    if (cs.notify && (cs.error || NotifyCloudOpenFail || NotifyCloudSoftSkip)) {
      // 失败通知用更短防抖键，避免与成功签名混淆；仍 3s 硬锁
      const failParsed = {
        ok: false,
        already: false,
        points: null,
        signCount: null,
        fail: cs.error ? 1 : 0,
        soft: cs.error ? 0 : 1,
        msg: String(cs.notify || "").slice(0, 120)
      };
      if (claimCloudAutoNotify(ACCOUNT, failParsed)) {
        await notify(maskPhone(ACCOUNT.phone || phone) + "·云盘");
      }
    }
  } catch (e) {
    clog("tryCloudAutoSignOnOpen error => " + e);
  } finally {
    // 成功则保留 inflight 到 CloudOpenInflightMs，防止紧接第二次 getUser 再跑
    // 失败则立刻释放，允许重新打开云盘重试
    const cs = merge.CloudSign || {};
    if (!cs.success) releaseCloudOpenInflight(phone);
  }
}

function cloudYmd() {
  const d = new Date();
  const p = n => (n < 10 ? "0" : "") + n;
  return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

function readCloudDayMap() {
  try {
    const raw = $nobyda.read("CMCC_CloudSignedDayMap") || "";
    if (!raw) return {};
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    return {};
  }
}

function isCloudDoneToday(phone) {
  if (!isValidPhone(phone)) return false;
  try {
    const map = readCloudDayMap();
    if (map[phone] === cloudYmd()) return true;
    // 兼容单键
    const one = $nobyda.read("CMCC_CloudSignedDay") || "";
    if (one === phone + "|" + cloudYmd()) return true;
  } catch (e) {}
  return false;
}

function markCloudDoneToday(phone, parsed) {
  if (!isValidPhone(phone)) return;
  try {
    const ymd = cloudYmd();
    const map = readCloudDayMap();
    map[phone] = ymd;
    // 只保留近 20 个号，防键膨胀
    const keys = Object.keys(map);
    if (keys.length > 20) {
      keys.slice(0, keys.length - 20).forEach(k => { delete map[k]; });
    }
    $nobyda.write(JSON.stringify(map), "CMCC_CloudSignedDayMap");
    $nobyda.write(phone + "|" + ymd, "CMCC_CloudSignedDay");
    if (parsed && parsed.ok) {
      upsertAccount({
        phone: phone,
        cloudLastSignYmd: ymd,
        cloudLastSignPoints: parsed.points != null ? parsed.points : undefined,
        updatedAt: Date.now(),
        source: "cloud-day-mark"
      }, true);
    }
  } catch (e) {}
}

function claimCloudOpenInflight(phone) {
  const now = Date.now();
  const gap = Number(CloudOpenInflightMs) || 45000;
  try {
    const raw = $nobyda.read("CMCC_CloudOpenInflight") || "";
    if (raw) {
      const parts = String(raw).split("|");
      const p = parts[0];
      const at = Number(parts[1] || 0);
      const token = parts[2] || "";
      if (p === phone && at && now - at < gap) return false;
      // 其它号占用中也整体互斥（云盘一般单号活跃，防并发打穿）
      if (p && p !== phone && at && now - at < gap) return false;
    }
    const token = String(now) + "-" + Math.floor(Math.random() * 1e6);
    $nobyda.write(phone + "|" + now + "|" + token, "CMCC_CloudOpenInflight");
    return token;
  } catch (e) {
    return "1";
  }
}

/** CAS：写锁 → 随机等待 80–220ms → 复核仍是自己的 token 才放行 */
async function claimCloudOpenInflightCas(phone) {
  const token = claimCloudOpenInflight(phone);
  if (!token) return false;
  const jitter = 80 + Math.floor(Math.random() * 140);
  await wait(jitter);
  try {
    const raw = $nobyda.read("CMCC_CloudOpenInflight") || "";
    const parts = String(raw).split("|");
    if (parts[0] === phone && parts[2] === token) return true;
    return false;
  } catch (e) {
    return !!token;
  }
}

function releaseCloudOpenInflight(phone) {
  try {
    const raw = $nobyda.read("CMCC_CloudOpenInflight") || "";
    if (!raw || String(raw).indexOf(phone) === 0) $nobyda.write("", "CMCC_CloudOpenInflight");
  } catch (e) {}
}

function cloudNotifyPseudoFromMerge(cs) {
  const n = String((cs && cs.notify) || "");
  const points = matchOne(n, /([+]?(\d+))豆/) || matchOne(String((cs && cs.bean) || ""), /(\d+)/);
  const signCount = matchOne(n, /连签(\d+)天/);
  return {
    ok: true,
    already: /已签到/.test(n),
    points: points != null ? Number(points) : null,
    signCount: signCount != null ? Number(signCount) : null
  };
}

function shouldWriteCloudBasic(auth) {
  try {
    const tail = String(auth || "").slice(-32);
    const last = $nobyda.read("CMCC_CloudBasicTail") || "";
    const at = Number($nobyda.read("CMCC_CloudBasicAt") || 0);
    const gap = Number(CloudBasicWriteThrottleMs) || 60000;
    if (last === tail && at && Date.now() - at < gap) return false;
    return true;
  } catch (e) { return true; }
}

function rememberCloudBasic(auth) {
  try {
    $nobyda.write(String(auth || "").slice(-32), "CMCC_CloudBasicTail");
    $nobyda.write(String(Date.now()), "CMCC_CloudBasicAt");
  } catch (e) {}
}

/********************* 动态签到：移动云盘（ycloud） *********************/
/**
 * Basic → querySpecTokenV2 → tyrzLogin → startSignIn
 * - 定时任务：always
 * - 打开云盘 getUser：AutoCloudLiveSignOnOpen=true 时由 tryCloudAutoSignOnOpen 调用
 * @param {number} s delay ms
 * @param {{openOnce?:boolean}} opts openOnce=true 时不做第二轮 SSO/jwt 重试，降低 rewrite 超时风险
 */
function LiveCloudSign(s, opts) {
  merge.CloudSign = {};
  const openOnce = !!(opts && opts.openOnce);
  return new Promise(resolve => {
    setTimeout(async () => {
      try {
        if (!EnableCloudSign) {
          merge.CloudSign.notify = "";
          return resolve();
        }
        if (!ACCOUNT.cloudAuthorization && !ACCOUNT.cloudSsoToken && !ACCOUNT.cloudJwt) {
          merge.CloudSign.notify = "跳过云盘：尚无云盘凭证（请打开一次移动云盘 App）";
          return resolve();
        }

        // 每日锁：成功过的号当天不再打接口。openOnce 且仍要「打开即签体验」时：本地锁命中仍当成功返回，外层会通知一次已签。
        if (CloudDailyOnce && isValidPhone(ACCOUNT.phone) && isCloudDoneToday(ACCOUNT.phone)) {
          merge.CloudSign.success = 1;
          merge.CloudSign.notify = "云盘: 今日已签到";
          return resolve();
        }

        const ua = ACCOUNT.cloudUA || ACCOUNT.userAgent ||
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) MCloudApp/13.0.0 iPhone AppLanguage/zh-CN";
        const deviceId = ACCOUNT.cloudDeviceId || "";

        let jwtToken = (ACCOUNT.cloudJwt && ACCOUNT.cloudJwt.length > 20) ? ACCOUNT.cloudJwt : "";
        let ssoToken = (ACCOUNT.cloudSsoToken && /^YZsidssolg/i.test(ACCOUNT.cloudSsoToken)) ? ACCOUNT.cloudSsoToken : "";

        // A) 无 jwt：Basic 现换 SSO → tyrz（打开路径最多 2 轮新票，避免 rewrite 超时）
        if (!jwtToken) {
          // 打开自签不用缓存 SSO（可能已被 App/上次失败污染）
          if (openOnce || (ACCOUNT.cloudAuthorization && /Basic\s+/i.test(ACCOUNT.cloudAuthorization))) {
            const got = await fetchCloudJwtWithFreshSso(ua, deviceId, openOnce);
            jwtToken = got.jwt || "";
            ssoToken = got.sso || "";
          } else if (ssoToken) {
            jwtToken = await fetchCloudJwtFromTyrz(ssoToken, ua, deviceId);
            if (!jwtToken) {
              clearCloudSso(ACCOUNT.phone);
              ACCOUNT.cloudSsoToken = "";
              const got = await fetchCloudJwtWithFreshSso(ua, deviceId, false);
              jwtToken = got.jwt || "";
              ssoToken = got.sso || "";
            }
          } else {
            const got = await fetchCloudJwtWithFreshSso(ua, deviceId, false);
            jwtToken = got.jwt || "";
            ssoToken = got.sso || "";
          }
          if (jwtToken) {
            clearCloudSso(ACCOUNT.phone);
            ACCOUNT.cloudSsoToken = "";
          }
        }

        if (!jwtToken) {
          const diag = readCloudTyrzDiag();
          merge.CloudSign.notify =
            "跳过云盘：tyrzLogin 未换到 jwt" + (diag ? (" · " + diag.slice(0, 160)) : "（日志无原文，请更新脚本）");
          clog("cloud jwt empty after tyrz " + (diag || ""));
          return resolve();
        }

        try {
          upsertAccount({
            phone: ACCOUNT.phone,
            cloudSsoToken: "", // 用过即清
            cloudJwt: jwtToken,
            cloudAuthorization: ACCOUNT.cloudAuthorization || "",
            cloudUA: ua,
            cloudDeviceId: deviceId || undefined,
            updatedAt: Date.now(),
            source: "cloud-sign-session"
          }, true);
          ACCOUNT.cloudJwt = jwtToken;
        } catch (e) {}

        const signHeaders = buildCloudSignHeaders(jwtToken, ua, deviceId, ssoToken || "");

        // B) startSignIn
        let signed = await callCloudStartSignIn(signHeaders);
        // jwt 过期：cron 再换一轮；打开自签为赶 rewrite 时限不再重试
        if (!signed.ok && signed.needNewJwt && ACCOUNT.cloudAuthorization && !openOnce) {
          console.log("cloud jwt invalid, refresh via Basic…");
          clearCloudJwt(ACCOUNT.phone);
          ACCOUNT.cloudJwt = "";
          const freshSso = await fetchCloudSsoToken(ua);
          if (freshSso) {
            const nj = await fetchCloudJwtFromTyrz(freshSso, ua, deviceId);
            if (nj) {
              jwtToken = nj;
              ACCOUNT.cloudJwt = nj;
              clearCloudSso(ACCOUNT.phone);
              signed = await callCloudStartSignIn(buildCloudSignHeaders(jwtToken, ua, deviceId, freshSso));
            }
          }
        }

        if (signed.ok) {
          merge.CloudSign.success = 1;
          if (signed.already) {
            merge.CloudSign.notify = "云盘: 今日已签到" + (signed.points != null ? ` · ${signed.points}豆` : "");
          } else {
            merge.CloudSign.notify = "云盘: 签到成功" + (signed.points != null ? ` · +${signed.points}豆` : "");
          }
          if (signed.points != null) merge.CloudSign.bean = signed.points + "豆";
          else if (signed.reward) merge.CloudSign.bean = signed.reward;
          if (signed.signCount != null) merge.CloudSign.notify += ` · 连签${signed.signCount}天`;
          if (CloudDailyOnce && isValidPhone(ACCOUNT.phone)) markCloudDoneToday(ACCOUNT.phone, signed);
          return resolve();
        }

        if (signed.softSkip) {
          merge.CloudSign.notify = "跳过云盘：" + (signed.msg || "接口不可用");
          return resolve();
        }

        merge.CloudSign.error = 1;
        merge.CloudSign.notify = "云盘: 签到未成功" + (signed.msg ? ` · ${signed.msg}` : "");
      } catch (e) {
        merge.CloudSign.notify = "跳过云盘：异常 " + e;
      } finally {
        resolve();
      }
    }, s);
  });
}

function cloudAutoKey(acc) {
  const p = acc && isValidPhone(acc.phone) ? acc.phone : "";
  if (p) return "p:" + p;
  const jwt = acc && acc.cloudJwt ? String(acc.cloudJwt).slice(-24) : "";
  if (jwt) return "j:" + jwt;
  const auth = acc && acc.cloudAuthorization ? String(acc.cloudAuthorization).slice(-24) : "";
  if (auth) return "a:" + auth;
  return "global";
}

function shouldFireCloudAuto(acc) {
  const now = Date.now();
  const gap = Number(CloudAutoDebounceMs) || 60000;
  // 进程内快路径（同一次 QX 多 rewrite 并发靠存储）
  try {
    const gAt = Number($nobyda.read("CMCC_CloudAutoAt") || 0);
    if (gAt && now - gAt < gap) return false;
  } catch (e) {}
  if (!acc) return true;
  return !acc.cloudAutoAt || now - Number(acc.cloudAutoAt || 0) > gap;
}

function markCloudAuto(acc) {
  const now = Date.now();
  try { $nobyda.write(String(now), "CMCC_CloudAutoAt"); } catch (e) {}
  try { $nobyda.write(cloudAutoKey(acc), "CMCC_CloudAutoKey"); } catch (e) {}
  const phone = (acc && isValidPhone(acc.phone) && acc.phone) || resolveRecentCloudPhone();
  if (phone || (acc && (acc.cloudJwt || acc.cloudAuthorization))) {
    upsertAccount({
      phone: phone || (acc && acc.phone) || "",
      cloudAuthorization: acc && acc.cloudAuthorization,
      cloudSsoToken: acc && acc.cloudSsoToken,
      cloudJwt: acc && acc.cloudJwt,
      cloudAutoAt: now,
      updatedAt: now,
      source: "cloud-auto-mark"
    }, true);
  }
}

// 跨并发抢锁：谁先 claim 谁通知；结果签名相同则 60s 内只报一次
function claimCloudAutoNotify(acc, parsed) {
  const now = Date.now();
  const gap = Number(CloudAutoDebounceMs) || 60000;
  const sig = [
    parsed && parsed.already ? "1" : "0",
    parsed && parsed.points != null ? parsed.points : "",
    parsed && parsed.signCount != null ? parsed.signCount : "",
    (acc && acc.phone) || "",
    (acc && acc.cloudJwt ? String(acc.cloudJwt).slice(-12) : "")
  ].join("|");
  try {
    const lastAt = Number($nobyda.read("CMCC_CloudAutoAt") || 0);
    const lastSig = $nobyda.read("CMCC_CloudNotifySig") || "";
    if (lastAt && now - lastAt < gap && lastSig === sig) return false;
    if (lastAt && now - lastAt < 3000) return false; // 3s 硬锁防并发双报
    $nobyda.write(String(now), "CMCC_CloudAutoAt");
    $nobyda.write(sig, "CMCC_CloudNotifySig");
  } catch (e) {}
  markCloudAuto(acc);
  return true;
}

function upsertCloudSession(fields) {
  const phone =
    (fields && isValidPhone(fields.phone) && fields.phone) ||
    resolveRecentCloudPhone() ||
    "";
  const patch = Object.assign({}, fields || {}, {
    phone: phone || (fields && fields.phone) || "",
    updatedAt: Date.now()
  });
  // 无任何身份则放弃（避免幽灵）
  if (!isValidPhone(patch.phone) && !patch.cloudAuthorization && !patch.cloudJwt && !patch.cloudSsoToken) {
    return null;
  }
  // 有 jwt/sso 但无号：尽量并入最近云盘号账号
  if (!isValidPhone(patch.phone)) {
    const recent = findRecentCloudAccount();
    if (recent && isValidPhone(recent.phone)) patch.phone = recent.phone;
  }
  return upsertAccount(patch, true);
}

function resolveRecentCloudPhone() {
  const a = findRecentCloudAccount();
  return a && isValidPhone(a.phone) ? a.phone : "";
}

function findRecentCloudAccount() {
  try {
    const list = loadAccounts()
      .filter(a => a && (a.cloudAuthorization || a.cloudJwt || a.cloudSsoToken || (a.phone && isValidPhone(a.phone))))
      .sort((x, y) => Number(y.updatedAt || 0) - Number(x.updatedAt || 0));
    // 优先有合法手机号且带云盘字段的
    const withPhone = list.find(a => isValidPhone(a.phone) && (a.cloudAuthorization || a.cloudJwt));
    if (withPhone) return withPhone;
    return list.find(a => isValidPhone(a.phone)) || list[0] || null;
  } catch (e) {
    return null;
  }
}

function clearCloudSso(phone) {
  const p = isValidPhone(phone) ? phone : resolveRecentCloudPhone();
  if (!isValidPhone(p)) return;
  upsertAccount({ phone: p, cloudSsoToken: "", updatedAt: Date.now(), source: "cloud-clear-sso" }, true);
}

function clearCloudJwt(phone) {
  const p = isValidPhone(phone) ? phone : resolveRecentCloudPhone();
  if (!isValidPhone(p)) return;
  upsertAccount({ phone: p, cloudJwt: "", updatedAt: Date.now(), source: "cloud-clear-jwt" }, true);
}

function parseCloudStartSignInBody(raw) {
  try {
    const j = typeof raw === "string" ? JSON.parse(stripChunkPrefix(raw) || "{}") : (raw || {});
    return interpretCloudStartSignIn(j);
  } catch (e) {
    return { ok: false, msg: "parse fail" };
  }
}

function interpretCloudStartSignIn(j) {
  if (!j) return { ok: false, msg: "空响应" };
  const text = typeof j === "string" ? j : JSON.stringify(j);
  if (isCloudMarketDead(j) || /request not found|not found|404/i.test(text)) {
    return { ok: false, softSkip: true, msg: "ycloud startSignIn 不可用" };
  }
  if (Number(j.code) !== 0 && j.msg && !/success/i.test(String(j.msg))) {
    if (/票据|过期|登录|未授权|token|jwt/i.test(String(j.msg))) {
      return { ok: false, softSkip: true, needNewJwt: true, msg: j.msg };
    }
    return { ok: false, msg: j.msg || ("code=" + j.code) };
  }
  const result = (j && j.result) || {};
  const today = !!result.todaySignIn;
  const points = result.signInPoints != null ? Number(result.signInPoints) : null;
  const signCount = result.signCount != null ? Number(result.signCount) : null;
  if (Number(j.code) === 0 || /success/i.test(String(j.msg || ""))) {
    return {
      ok: true,
      already: today,
      points: Number.isFinite(points) ? points : null,
      signCount: Number.isFinite(signCount) ? signCount : null,
      reward: points != null ? (points + "豆") : extractReward(text),
      raw: j
    };
  }
  return { ok: false, msg: j.msg || shortBody(text), raw: j };
}

function buildCloudSignHeaders(jwtToken, ua, deviceId, ssoToken) {
  const refTok = ssoToken || "";
  const referer =
    "https://m.mcloud.139.com/portal/mobilecloud/index.html?path=newsignin&sourceid=" +
    encodeURIComponent(CloudSourceId || "1002") +
    "&enableShare=1&token=" + encodeURIComponent(refTok) +
    "&targetSourceId=" + encodeURIComponent(CloudTargetSourceId || "001005");
  const h = {
    "User-Agent": ua || "Mozilla/5.0 MCloudApp/13.0.0",
    Accept: "*/*",
    Origin: "https://m.mcloud.139.com",
    Referer: referer,
    activityId: CloudMarketName || "sign_in_3",
    jwtToken: jwtToken,
    Cookie: "jwtToken=" + jwtToken
  };
  if (deviceId) h.deviceId = deviceId;
  return h;
}

async function fetchCloudSsoToken(ua, opts) {
  // 1) 首选：user-njs querySpecTokenV2 + Basic
  // 注意：签到页 portal 用 targetSourceId=001005；001003 多为其它入口，tyrz(market sign_in_3) 易失败
  // opts.once：打开自签只打 njs+001005 一次，避免 rewrite 超时
  const once = !!(opts && opts.once);
  if (ACCOUNT.cloudAuthorization && /Basic\s+/i.test(ACCOUNT.cloudAuthorization)) {
    const headers = {
      "User-Agent": ua,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: ACCOUNT.cloudAuthorization,
      "x-MM-Source": "001",
      Origin: "mcloudlocal://yun.139.com",
      // 与 getUser 对齐的可选字段（抓包常有）
      APP_NUMBER: ACCOUNT.appNumber || ACCOUNT.phone || "",
      NOTE_TOKEN: ACCOUNT.noteToken || ""
    };
    if (ACCOUNT.cloudDeviceId) headers.deviceId = ACCOUNT.cloudDeviceId;
    const hosts = once
      ? ["https://user-njs.yun.139.com/user/querySpecTokenV2"]
      : [
        "https://user-njs.yun.139.com/user/querySpecTokenV2",
        "https://user.yun.139.com/user/querySpecTokenV2"
      ];
    const sources = once
      ? [CloudTargetSourceId || "001005"]
      : [CloudTargetSourceId || "001005", CloudTargetSourceIdAlt || "001003"];
    for (let si = 0; si < sources.length; si++) {
      for (let hi = 0; hi < hosts.length; hi++) {
        try {
          const jres = await httpJson("POST", hosts[hi], headers, { toSourceId: sources[si] });
          const tok = jres && jres.data && jres.data.token;
          if (tok && /^YZsidssolg/i.test(tok)) {
            clog("querySpecTokenV2 ok => " + sources[si] + " " + hosts[hi].replace(/^https:\/\//, "").split("/")[0]);
            return tok;
          }
          if (jres && jres.raw && typeof jres.raw === "string" && jres.raw.length > 20 && !/^\{/.test(jres.raw.trim())) {
            // 密文响应：本机无法解，换 host/source 继续
            clog("querySpecTokenV2 cipher on " + sources[si]);
          }
        } catch (e) {}
      }
    }
  }

  // 2) 兼容旧 orchestration 路径（成功率低，仅兜底；openOnce 跳过）
  if (!once && ACCOUNT.phone && ACCOUNT.cloudAuthorization) {
    try {
      const j = await httpJson("POST",
        "https://orches.yun.139.com/orchestration/auth-rebuild/token/v1.0/querySpecToken",
        {
          "User-Agent": ua,
          Accept: "*/*",
          Authorization: ACCOUNT.cloudAuthorization,
          "Content-Type": "application/json"
        },
        { account: ACCOUNT.phone, toSourceId: CloudTargetSourceId || "001005" }
      );
      const tok = j && j.data && j.data.token;
      if (tok && /^YZsidssolg/i.test(tok)) return tok;
    } catch (e) {}
  }
  return "";
}

/**
 * 从 tyrzLogin 响应中抠 jwt（抓包多为 result.token=eyJ...；也有 result 直接是 jwt）
 */
function extractJwtFromTyrz(j) {
  if (!j || typeof j !== "object") return "";
  const cands = [];
  const push = v => {
    if (v == null) return;
    if (typeof v === "string" && v.length > 20) cands.push(v);
    else if (typeof v === "object") {
      if (v.token) cands.push(String(v.token));
      if (v.jwtToken) cands.push(String(v.jwtToken));
      if (v.jwt) cands.push(String(v.jwt));
      if (v.accessToken) cands.push(String(v.accessToken));
    }
  };
  push(j.result);
  push(j.data);
  push(j.token);
  push(j.jwtToken);
  if (j.result && typeof j.result === "object") push(j.result.data);
  for (let i = 0; i < cands.length; i++) {
    const t = String(cands[i] || "").trim();
    // 标准 jwt 或足够长的会话串
    if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/.test(t)) return t;
    if (t.length > 40 && !/^YZsid/i.test(t) && !/\s/.test(t)) return t;
  }
  // 裸扫
  try {
    const m = JSON.stringify(j).match(/"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+)"/);
    if (m) return m[1];
  } catch (e) {}
  return "";
}

function buildTyrzBodies(ssoToken) {
  const tok = ssoToken;
  const mid = CloudMarketName || "sign_in_3";
  // 抓包主形态在前；后续为兼容
  return [
    { token: tok, openAccount: 0, marketName: mid, sourceId: String(CloudSourceId || "1002") },
    { token: tok, openAccount: 0, marketName: mid, sourceId: Number(CloudSourceId || 1002) },
    { token: tok, openAccount: "0", marketName: mid, sourceId: String(CloudSourceId || "1002") },
    { token: tok, openAccount: 0, marketName: mid, sourceId: String(CloudSourceId || "1002"), client: "app" },
    { token: tok, openAccount: 0, marketName: mid, sourceId: String(CloudTargetSourceId || "001005") },
    { token: tok, openAccount: 0, marketName: mid },
    { token: tok, marketName: mid, sourceId: String(CloudSourceId || "1002") }
  ];
}

async function fetchCloudJwtFromTyrz(ssoToken, ua, deviceId) {
  if (!ssoToken) return "";
  const headers = buildCloudSignHeaders("pending", ua, deviceId, ssoToken);
  // tyrz 请求阶段尚无 jwt，去掉无效 jwt 头
  delete headers.jwtToken;
  delete headers.Cookie;
  headers["Content-Type"] = "application/json;charset=UTF-8";
  headers.Accept = "application/json, text/plain, */*";
  headers["Accept-Language"] = "zh-CN,zh-Hans;q=0.9";
  headers["X-Requested-With"] = "XMLHttpRequest";
  // 部分 H5 还会带 mcloud 宿主 UA；若 Basic 场景拿到的是原生 UA，换成 MCloud 网页 UA 更像签到页
  if (headers["User-Agent"] && /ChinaMobile\//i.test(headers["User-Agent"]) && !/MCloudApp/i.test(headers["User-Agent"])) {
    headers["User-Agent"] =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MCloudApp/13.0.0";
  }
  if (deviceId) headers.deviceId = deviceId;
  // 注意：真实 H5 tyrz 通常不带 Basic Authorization；带 Basic 可能导致空/拒响应
  // 不在此附加 ACCOUNT.cloudAuthorization

  // 同一 SSO 只打 1 枪；必要时再试「精简头」一次（部分 QX 环境下冗余头导致空响应）
  const bodyObj = buildTyrzBodies(ssoToken)[0];
  const payload = JSON.stringify(bodyObj);
  const headerVariants = [
    headers,
    {
      "User-Agent": headers["User-Agent"] || ua,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      Origin: "https://m.mcloud.139.com",
      Referer: headers.Referer
    }
  ];
  let lastDiag = "";
  for (let hi = 0; hi < headerVariants.length; hi++) {
    try {
      const raw = await httpRaw(
        "POST",
        "https://m.mcloud.139.com/ycloud/auth-service/auth/tyrzLogin",
        headerVariants[hi],
        payload
      );
      let bodyText = "";
      if (raw && raw.body != null) {
        bodyText = typeof raw.body === "string" ? raw.body : String(raw.body);
        bodyText = stripChunkPrefix(bodyText);
      }
      const st = raw ? (raw.status || 0) : 0;
      const er = raw && raw.error ? String(raw.error) : "";
      // 关键：QX 控制台多参数 log 会丢后续参数，必须拼成单字符串
      lastDiag =
        "h" + hi +
        " http=" + st +
        " err=" + er +
        " len=" + bodyText.length +
        " head=" + bodyText.replace(/\s+/g, " ").slice(0, 200);
      clog("tyrz raw => " + lastDiag);
      rememberCloudTyrzDiag(lastDiag);

      let j = {};
      if (bodyText) {
        try { j = JSON.parse(bodyText); } catch (e) { j = { raw: bodyText, status: st }; }
      } else {
        j = { empty: true, status: st, error: er };
      }
      const jwt = extractJwtFromTyrz(j);
      if (jwt) {
        clog("tyrzLogin ok h=" + hi + " len=" + jwt.length);
        return jwt;
      }
      // 有明确业务 JSON：不必换头重试（票可能已消费）
      if (bodyText && /\{/.test(bodyText) && (j.code != null || j.msg || j.result != null)) {
        const keys = Object.keys(j).slice(0, 10).join(",");
        lastDiag =
          "h" + hi +
          " http=" + st +
          " code=" + j.code +
          " msg=" + String(j.msg || "") +
          " keys=" + keys +
          " head=" + bodyText.replace(/\s+/g, " ").slice(0, 160);
        clog("tyrzLogin fail => " + lastDiag);
        rememberCloudTyrzDiag(lastDiag);
        break;
      }
      // 空响应 / 非 JSON：换精简头再试（同一 SSO 第二次请求可能仍有效或仍空）
      if (hi + 1 < headerVariants.length && (!bodyText || st === 0)) {
        clog("tyrz empty/0, retry minimal headers");
        continue;
      }
      clog("tyrzLogin fail => " + lastDiag);
      rememberCloudTyrzDiag(lastDiag);
    } catch (e) {
      lastDiag = "error " + e;
      clog("tyrzLogin error => " + lastDiag);
      rememberCloudTyrzDiag(lastDiag);
    }
  }
  if (lastDiag) clog("tyrzLogin last => " + lastDiag);
  return "";
}

function rememberCloudTyrzDiag(diag) {
  try {
    $nobyda.write(String(diag || "").slice(0, 500), "CMCC_LastTyrzDiag");
  } catch (e) {}
  try {
    if (typeof merge === "object" && merge) merge._lastTyrzDiag = String(diag || "").slice(0, 500);
  } catch (e) {}
}

function readCloudTyrzDiag() {
  try {
    if (merge && merge._lastTyrzDiag) return String(merge._lastTyrzDiag);
  } catch (e) {}
  try { return $nobyda.read("CMCC_LastTyrzDiag") || ""; } catch (e) { return ""; }
}

/**
 * 打开自签：SSO 可能一次换 jwt 失败 → 最多再换 1 张新 SSO 重试（仍限时）
 */
async function fetchCloudJwtWithFreshSso(ua, deviceId, openOnce) {
  let lastSso = "";
  const rounds = openOnce ? 2 : 3;
  for (let r = 0; r < rounds; r++) {
    const sso = await fetchCloudSsoToken(ua, { once: openOnce && r === 0 });
    if (!sso) {
      clog("cloud sso empty round " + r);
      break;
    }
    if (sso === lastSso) {
      clog("cloud sso same as last, stop");
      break;
    }
    lastSso = sso;
    clog("cloud tyrz try round " + r + " ssoTail=" + String(sso).slice(-12));
    const jwt = await fetchCloudJwtFromTyrz(sso, ua, deviceId);
    if (jwt) return { jwt: jwt, sso: sso };
    // 票已废，清缓存再申请
    clearCloudSso(ACCOUNT.phone);
    ACCOUNT.cloudSsoToken = "";
    if (r + 1 < rounds) await wait(200);
  }
  return { jwt: "", sso: lastSso };
}

async function callCloudStartSignIn(headers) {
  try {
    const j = await httpJson("GET",
      "https://m.mcloud.139.com/ycloud/signin/page/startSignIn?client=app",
      headers,
      null
    );
    return interpretCloudStartSignIn(j);
  } catch (e) {
    return { ok: false, msg: String(e) };
  }
}

function isCloudMarketDead(j) {
  if (!j) return false;
  const s = typeof j === "string" ? j : JSON.stringify(j);
  return /request not found|not found|404|path error|接口不存在/i.test(s);
}

function isCloudDeadMsg(msg) {
  return /request not found|not found|404|接口不存在/i.test(String(msg || ""));
}

function stripChunkPrefix(raw) {
  // 部分抓包/代理响应可能带 chunk 长度前缀，例如 "4ba\n{...}\n0"
  let s = String(raw || "").trim();
  if (!s) return s;
  if (s[0] === "{" || s[0] === "[") return s;
  const m = s.match(/^[0-9a-fA-F]+\s*[\r\n]+([\s\S]*)$/);
  if (m) {
    s = m[1].replace(/[\r\n]+0\s*$/, "").trim();
  }
  // 再试：截取第一个 { 到最后一个 }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) return s.slice(a, b + 1);
  return s;
}

/********************* 动态签到：qwhdhub 签到领奖（主路径） *********************/
/**
 * 真实链路（禁止在无 QWHD_SESSION_TOKEN 时盲探 mark API）：
 * open hub → qwhdsso/login(sid) → appTokenLogin(JSESSIONID token) →
 * page token → QWHD_SESSION_TOKEN → markstatus → domark {"date":yyyyMMdd}
 */
function LiveQwhdSign(s) {
  merge.QwhdSign = {};
  return new Promise(resolve => {
    setTimeout(async () => {
      try {
        if (!ACCOUNT.cookie && !ACCOUNT.jsessionid) {
          merge.QwhdSign.notify = "跳过签到领奖：尚无 App 登录会话(JSESSIONID)";
          return resolve();
        }

        // 1) 换取/刷新 H5 会话（QWHD_SESSION_TOKEN）
        const sess = await ensureQwhdSession();
        if (!sess.ok) {
          merge.QwhdSign.error = 1;
          merge.QwhdSign.notify = "签到领奖: H5 SSO 失败 · " + (sess.msg || "未知");
          return resolve();
        }
        // 硬门槛：没有 QWHD_SESSION_TOKEN 绝不打 mark API（否则固定返回 HTML 404 页）
        if (!ACCOUNT.qwhdSession) {
          merge.QwhdSign.error = 1;
          merge.QwhdSign.notify = "签到领奖: 缺 QWHD_SESSION_TOKEN。请在 App 打开一次「签到领奖」页（MITM 捕获会话）";
          return resolve();
        }

        const day = yyyymmdd();
        const actId = ACCOUNT.activityId || QwhdActivityId;
        const channelId = ACCOUNT.channelId || QwhdChannelId;
        const yx = ACCOUNT.yx || QwhdYx;
        const pageUrl =
          `https://wx.10086.cn/qwhdhub/qwhdmark/${actId}?channelId=${encodeURIComponent(channelId)}` +
          `&yx=${encodeURIComponent(yx)}` +
          (ACCOUNT.h5Token ? `&token=${encodeURIComponent(ACCOUNT.h5Token)}` : "");

        const headers = buildQwhdApiHeaders(pageUrl);

        // 2) markstatus：看今日是否已签（data.markstatus[].date/status）
        const statusUrl = "https://wx.10086.cn/qwhdhub/api/mark/mark31/markstatus";
        const st = await httpRaw("POST", statusUrl, headers, "{}").catch(e => ({ error: String(e), status: 0, body: "" }));
        if (st.error || isQwhdAuthFail(st)) {
          // 会话失效则强制重登一次
          const again = await ensureQwhdSession(true);
          if (!again.ok) {
            merge.QwhdSign.error = 1;
            merge.QwhdSign.notify = "签到领奖: markstatus 无有效会话 · " + (st.error || shortBody(st.body) || ("HTTP " + st.status));
            return resolve();
          }
          Object.assign(headers, buildQwhdApiHeaders(pageUrl));
        }

        let st2 = st;
        if (isQwhdAuthFail(st) || st.error) {
          st2 = await httpRaw("POST", statusUrl, headers, "{}").catch(e => ({ error: String(e), status: 0, body: "" }));
        }

        const already = isTodayMarked(st2 && st2.body, day);
        if (already) {
          merge.QwhdSign.success = 1;
          merge.QwhdSign.notify = "签到领奖: 今日已签到";
          // 仍可尝试领取可领任务奖
          if (AutoClaimTaskAward) {
            const award = await claimTaskAwardsFromStatus(st2 && st2.body, headers);
            if (award) merge.QwhdSign.bean = award;
          }
          return resolve();
        }

        // 3) 唯一动作：POST /mark31/domark  body={"date":"yyyyMMdd"}（大小写必须 domark）
        const markUrl = "https://wx.10086.cn/qwhdhub/api/mark/mark31/domark";
        const markBody = JSON.stringify({ date: day });
        const mr = await httpRaw("POST", markUrl, headers, markBody).catch(e => ({ error: String(e), status: 0, body: "" }));
        const text = String((mr && mr.body) || "");
        if (LogDetails) console.log("domark", mr && mr.status, text.slice(0, 300));

        // 成功判定：code=SUCCESS / success=true；msg 可能是「未配置对应奖品」但仍算签到成功
        if (mr && !mr.error && !isQwhdAuthFail(mr) && isDomarkSuccess(text, mr.status)) {
          merge.QwhdSign.success = 1;
          const alreadyMsg = /已签|重复|ALREADY|SIGNED/i.test(text);
          merge.QwhdSign.notify = alreadyMsg ? "签到领奖: 今日已签" : "签到领奖: 签到成功";
          // 抓包成功样例: status=PRIZE_NO_CONFIG, msg=未配置对应奖品, success=true
          if (/PRIZE_NO_CONFIG|未配置对应奖品/i.test(text)) {
            merge.QwhdSign.notify += "（当日奖品未配置，任务进度已记）";
          }
          const prize = extractPrizeName(text);
          if (prize) merge.QwhdSign.bean = prize;

          // 4) 自动领 taskAwardChance
          if (AutoClaimTaskAward) {
            const chances = extractTaskAwardIds(text);
            if (chances.length) {
              const got = await claimTaskAwardIds(chances, headers);
              if (got) merge.QwhdSign.bean = (merge.QwhdSign.bean ? merge.QwhdSign.bean + " / " : "") + got;
            } else {
              // 再拉一次 status 看 chance
              const st3 = await httpRaw("POST", statusUrl, headers, "{}").catch(() => null);
              const got = await claimTaskAwardsFromStatus(st3 && st3.body, headers);
              if (got) merge.QwhdSign.bean = (merge.QwhdSign.bean ? merge.QwhdSign.bean + " / " : "") + got;
            }
          }
          // 把最新 H5 会话写回账号
          persistAccountSessionFields();
          return resolve();
        }

        // 失败分支
        if (isQwhdAuthFail(mr) || isHtmlNotice(text)) {
          merge.QwhdSign.error = 1;
          merge.QwhdSign.notify = "签到领奖: H5 会话无效（返回登录页/404）。请打开一次「签到领奖」后再登录触发";
        } else if (/已签|重复/i.test(text)) {
          merge.QwhdSign.success = 1;
          merge.QwhdSign.notify = "签到领奖: 今日已签";
        } else {
          merge.QwhdSign.error = 1;
          merge.QwhdSign.notify = "签到领奖: 未成功 · " + (mr && mr.error ? mr.error : shortBody(text) || ("HTTP " + (mr && mr.status)));
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

function buildQwhdApiHeaders(referer) {
  const token = ACCOUNT.qwhdSession || "";
  const yx = ACCOUNT.yx || QwhdYx;
  let cookie = "";
  if (token) cookie = `QWHD_SESSION_TOKEN=${token}`;
  if (yx) cookie += (cookie ? "; " : "") + `yx=${yx}`;
  // 合并已有 h5Cookie 里其他非关键字段也可，但核心必须有 QWHD_SESSION_TOKEN
  if (ACCOUNT.h5Cookie) cookie = mergeCookieString(ACCOUNT.h5Cookie, cookie);
  // 确保 QWHD_SESSION_TOKEN 不被旧值覆盖错
  if (token) {
    cookie = cookie.replace(/QWHD_SESSION_TOKEN=[^;]*/i, "QWHD_SESSION_TOKEN=" + token);
    if (!/QWHD_SESSION_TOKEN=/i.test(cookie)) cookie = `QWHD_SESSION_TOKEN=${token}; ` + cookie;
  }
  return {
    Accept: "*/*",
    "Content-Type": "application/json;charset=UTF-8",
    Origin: "https://wx.10086.cn",
    Referer: referer || `https://wx.10086.cn/qwhdhub/qwhdmark/${ACCOUNT.activityId || QwhdActivityId}`,
    "User-Agent": ACCOUNT.h5UA ||
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148/wkwebview leadeon/12.0.2/CMCCIT",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    "x-requested-with": "XMLHttpRequest",
    "login-check": "1",
    Cookie: cookie
  };
}

/**
 * 打开活动 → SSO 登录 → 种下 QWHD_SESSION_TOKEN
 * force=true 时忽略缓存强制重登
 */
async function ensureQwhdSession(force) {
  // 有效缓存：有 session 且 25 分钟内刷新过
  if (!force && ACCOUNT.qwhdSession && ACCOUNT.qwhdSessionAt && (Date.now() - ACCOUNT.qwhdSessionAt < 25 * 60 * 1000)) {
    return { ok: true, cached: true };
  }
  // 有 session 但无时间戳：仍先用，失败再 force
  if (!force && ACCOUNT.qwhdSession && !ACCOUNT.cookie && !ACCOUNT.jsessionid) {
    return { ok: true, cached: true };
  }

  if (!ACCOUNT.cookie && !ACCOUNT.jsessionid) {
    return { ok: false, msg: "缺少 JSESSIONID" };
  }

  const actId = ACCOUNT.activityId || QwhdActivityId;
  const channelId = ACCOUNT.channelId || QwhdChannelId;
  const yx = ACCOUNT.yx || QwhdYx;
  const actUrl =
    `https://wx.10086.cn/qwhdhub/qwhdmark/${actId}?channelId=${encodeURIComponent(channelId)}` +
    `&redCode=rec_feedHotZoneApp_${encodeURIComponent(channelId)}&yx=${encodeURIComponent(yx)}`;
  const h5UA =
    ACCOUNT.h5UA ||
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148/wkwebview leadeon/12.0.2/CMCCIT";

  // A. 打开活动页，跟随/解析 302 Location → qwhdsso/login?sid=...
  let sid = ACCOUNT.h5Token && /^QWHDSSO/i.test(ACCOUNT.h5Token) ? ACCOUNT.h5Token : "";
  let loginUrl = "";
  if (!sid) {
    const open = await httpRaw("GET", actUrl, {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": h5UA,
      "Accept-Language": "zh-CN,zh-Hans;q=0.9",
      Cookie: `yx=${yx}`
    }, null).catch(e => ({ error: String(e), headers: {}, body: "", status: 0 }));

    const loc = getHeader(open.headers || {}, "Location") || getHeader(open.headers || {}, "location") || "";
    loginUrl = loc || "";
    // 某些客户端自动跟跳，body/最终 URL 里也可能含 sid
    sid =
      matchOne(loginUrl, /[?&]sid=([^&]+)/i) ||
      matchOne(String(open.body || ""), /appTokenLogin\?sid=([^"'&]+)/i) ||
      matchOne(String(open.url || open.finalUrl || ""), /[?&](?:sid|token)=(QWHDSSO[^&]+)/i) ||
      "";
    // 若直接 200 且已带 session（罕见）
    const sc = getHeader(open.headers || {}, "Set-Cookie") || "";
    const exist = matchOne(sc, /QWHD_SESSION_TOKEN=([^;]+)/i);
    if (exist) {
      ACCOUNT.qwhdSession = exist;
      ACCOUNT.qwhdSessionAt = Date.now();
      ACCOUNT.h5Cookie = mergeCookieString(ACCOUNT.h5Cookie || "", sc);
      return { ok: true, sid: "cached-from-open" };
    }
  }

  if (!loginUrl && sid) {
    loginUrl = `https://wx.10086.cn/qwhdsso/login?dlwmh=true&actUrl=${encodeURIComponent(actUrl)}`;
  }

  // B. 访问 SSO 登录页，从 HTML 解析 sid（若上一步没拿到）
  if (!sid) {
    const ssoPageUrl = loginUrl || `https://wx.10086.cn/qwhdsso/login?dlwmh=true&actUrl=${encodeURIComponent(actUrl)}`;
    const page = await httpRaw("GET", ssoPageUrl, {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": h5UA,
      "Accept-Language": "zh-CN,zh-Hans;q=0.9",
      Cookie: `yx=${yx}`,
      Referer: actUrl
    }, null).catch(e => ({ error: String(e), body: "", headers: {} }));
    const html = String(page.body || "");
    sid =
      matchOne(html, /appTokenLogin\?sid=([^"'&\s]+)/i) ||
      matchOne(html, /sid=(QWHDSSO[A-Za-z0-9]+)/i) ||
      matchOne(getHeader(page.headers || {}, "Location") || "", /[?&]sid=([^&]+)/i) ||
      "";
    if (!sid) {
      return { ok: false, msg: "未解析到 QWHDSSO sid（SSO 页异常）" };
    }
  }

  // C. appTokenLogin —— 关键：token 字段 = App 的 session cookie 串
  const appToken = buildAppTokenString();
  if (!appToken) return { ok: false, msg: "无法构造 appToken(JSESSIONID)" };

  const provinceCode = ACCOUNT.provinceCode || DefaultProvinceCode;
  const cityCode = ACCOUNT.cityCode || DefaultCityCode;
  const phone = ACCOUNT.phone || "";
  const userCheckId = phone ? phoneToUserCheckId(phone) : (ACCOUNT.userCheckId || "");
  const version = ACCOUNT.appVersion || "12.0.2";
  const loginBody = {
    jwtToken: ACCOUNT.ssoJwt || null,
    token: appToken,
    provinceCode: String(provinceCode),
    cityCode: String(cityCode),
    userCheckId: userCheckId || String(Math.random()).slice(2, 11),
    carrierOperator: ACCOUNT.carrierOperator || DefaultCarrierOperator,
    appVersionCode: version,
    took: 80
  };

  const ssoHeaders = {
    Accept: "*/*",
    "Content-Type": "application/json;charset=UTF-8",
    Origin: "https://wx.10086.cn",
    Referer: loginUrl || `https://wx.10086.cn/qwhdsso/login?dlwmh=true&actUrl=${encodeURIComponent(actUrl)}`,
    "User-Agent": h5UA,
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    Cookie: `yx=${yx}`
  };

  const loginApi = `https://wx.10086.cn/qwhdsso/appTokenLogin?sid=${encodeURIComponent(sid)}`;
  const lr = await httpRaw("POST", loginApi, ssoHeaders, JSON.stringify(loginBody)).catch(e => ({ error: String(e), body: "", status: 0 }));
  if (lr.error) return { ok: false, msg: "appTokenLogin 网络错误: " + lr.error };

  let data = null;
  try { data = JSON.parse(lr.body || "{}"); } catch (e) {}
  if (!data || !(data.success === true || data.code === "SUCCESS") || !data.data) {
    return { ok: false, msg: "appTokenLogin 失败 · " + shortBody(lr.body) };
  }

  const jumpUrl = data.data.url || "";
  const h5Token = matchOne(jumpUrl, /[?&]token=([^&]+)/i) || sid;
  const jwt = data.data.jwt || "";
  ACCOUNT.h5Token = decodeURIComponentSafe(h5Token);
  ACCOUNT.ssoJwt = jwt || ACCOUNT.ssoJwt || "";
  ACCOUNT.activityId = matchOne(jumpUrl, /qwhdmark\/(\d+)/i) || actId;

  // D. 打开 jumpUrl，收 Set-Cookie: QWHD_SESSION_TOKEN
  const pr = await httpRaw("GET", jumpUrl || actUrl + `&token=${encodeURIComponent(ACCOUNT.h5Token)}`, {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": h5UA,
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    Referer: ssoHeaders.Referer,
    Cookie: `yx=${yx}`
  }, null).catch(e => ({ error: String(e), headers: {}, body: "" }));

  const setCookie = getHeader(pr.headers || {}, "Set-Cookie") || getHeader(pr.headers || {}, "set-cookie") || "";
  let qwhd =
    matchOne(setCookie, /QWHD_SESSION_TOKEN=([^;]+)/i) ||
    matchOne(String(pr.body || ""), /QWHD_SESSION_TOKEN=([^;,"'\s]+)/i) ||
    "";

  // 某些运行时 http 客户端不回传 Set-Cookie；再打一次 user/info 用 Cookie 空试？不行。
  // 兜底：用 token 访问页面时服务端应下发；若仍无，记下 token，后续 API 可能仍 302
  if (!qwhd && ACCOUNT.qwhdSession && !force) qwhd = ACCOUNT.qwhdSession;

  if (qwhd) {
    ACCOUNT.qwhdSession = qwhd;
    ACCOUNT.qwhdSessionAt = Date.now();
    ACCOUNT.h5Cookie = mergeCookieString(`yx=${yx}`, setCookie);
    ACCOUNT.h5Cookie = mergeCookieString(ACCOUNT.h5Cookie, `QWHD_SESSION_TOKEN=${qwhd}`);
    persistAccountSessionFields();
    return { ok: true, sid: sid };
  }

  // 没有 Set-Cookie 时：仍返回 ok=false，避免盲打 404
  // 但若环境把 cookie 藏进完整 cookie jar 无法读取，用户打开一次签到页即可被 MITM 捕获
  if (ACCOUNT.qwhdSession) {
    return { ok: true, sid: sid, msg: "沿用已有 QWHD_SESSION_TOKEN" };
  }
  return { ok: false, msg: "SSO 成功但未拿到 QWHD_SESSION_TOKEN（请在 App 点开一次签到页）" };
}

function buildAppTokenString() {
  // 抓包 #528: token 字段是完整 cookie 串
  // JSESSIONID=...; UID=...; Comment=SessionServer-unity; Path=/;HTTPOnly; ticketID=ShanDong; Secure
  if (ACCOUNT.cookie && /JSESSIONID=/i.test(ACCOUNT.cookie)) {
    let c = ACCOUNT.cookie;
    // 若只有 JSESSIONID/UID，补全官方 appTokenLogin 形态
    if (!/ticketID=/i.test(c)) {
      const tid = ACCOUNT.ticketId || "ShanDong";
      c = c.replace(/;?\s*$/, "") + `; Comment=SessionServer-unity; Path=/;HTTPOnly; ticketID=${tid}; Secure`;
    }
    return c;
  }
  if (ACCOUNT.jsessionid) {
    let c = `JSESSIONID=${ACCOUNT.jsessionid}`;
    if (ACCOUNT.uid) c += `; UID=${ACCOUNT.uid}`;
    c += `; Comment=SessionServer-unity; Path=/;HTTPOnly; ticketID=${ACCOUNT.ticketId || "ShanDong"}; Secure`;
    return c;
  }
  return "";
}

function phoneToUserCheckId(phone) {
  // SSO 页: parseFloat(phoneNumber).toString(16)
  try {
    const n = parseFloat(String(phone));
    if (!isFinite(n)) return "";
    return n.toString(16);
  } catch (e) {
    return "";
  }
}

function yyyymmdd(d) {
  const dt = d || new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function isQwhdAuthFail(r) {
  if (!r) return true;
  if (r.status === 302 || r.status === 401 || r.status === 403) return true;
  const b = String(r.body || "");
  const loc = getHeader(r.headers || {}, "Location") || "";
  if (/notice\/404|qwhdsso\/login/i.test(loc + b)) return true;
  if (isHtmlNotice(b)) return true;
  if (r.status >= 300 && r.status < 400 && !b) return true;
  return false;
}

function isHtmlNotice(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/^<!DOCTYPE html/i.test(s) || /^<html[\s>]/i.test(s)) return true;
  if (/notice\/404|请在中国移动APP内访问/i.test(s)) return true;
  return false;
}

function isTodayMarked(body, day) {
  const text = String(body || "");
  if (!text) return false;
  try {
    const j = JSON.parse(text);
    const list = j && j.data && j.data.markstatus;
    if (Array.isArray(list)) {
      const hit = list.find(x => String(x.date) === String(day));
      if (hit && (String(hit.status) === "1" || hit.status === 1 || hit.status === true)) return true;
    }
  } catch (e) {}
  // 兜底正则
  const re = new RegExp(`"date"\\s*:\\s*"?${day}"?[\\s\\S]{0,40}"status"\\s*:\\s*"?1"?'`, "i");
  return re.test(text);
}

function isDomarkSuccess(text, status) {
  if (isBizSuccess(text, status)) return true;
  // 签到记成功但奖品未配置
  if (/"code"\s*:\s*"SUCCESS"/i.test(text) && /PRIZE_NO_CONFIG|未配置对应奖品|taskAwardChance/i.test(text)) return true;
  if (/"success"\s*:\s*true/i.test(text) && /markPrize|taskAwardChance/i.test(text)) return true;
  return false;
}

function extractTaskAwardIds(text) {
  const ids = [];
  try {
    const j = JSON.parse(text || "{}");
    const arr = (j && j.data && j.data.taskAwardChance) || [];
    arr.forEach(x => { if (x && x.id) ids.push(String(x.id)); });
  } catch (e) {
    const re = /"id"\s*:\s*"(\d+)"/g;
    let m;
    while ((m = re.exec(String(text || "")))) ids.push(m[1]);
  }
  // 去重
  return Array.from(new Set(ids)).slice(0, 5);
}

function extractPrizeName(text) {
  const m = String(text || "").match(/"prizeName"\s*:\s*"([^"]+)"/);
  return m ? m[1] : "";
}

async function claimTaskAwardIds(ids, headers) {
  const names = [];
  for (let i = 0; i < ids.length; i++) {
    const u = `https://wx.10086.cn/qwhdhub/api/mark/mark31/taskAward/${ids[i]}`;
    const r = await httpRaw("POST", u, headers, "{}").catch(() => null);
    const t = (r && r.body) || "";
    if (r && isBizSuccess(t, r.status)) {
      names.push(extractPrizeName(t) || ("任务奖" + ids[i]));
    }
    await wait(200);
  }
  return names.join(", ");
}

async function claimTaskAwardsFromStatus(body, headers) {
  try {
    const j = JSON.parse(body || "{}");
    const chances = (j && j.data && j.data.taskAwardChance) || [];
    const ids = chances.map(x => x && x.id).filter(Boolean).map(String);
    if (!ids.length) return "";
    return claimTaskAwardIds(ids, headers);
  } catch (e) {
    return "";
  }
}

function persistAccountSessionFields() {
  try {
    upsertAccount({
      phone: ACCOUNT.phone,
      jsessionid: ACCOUNT.jsessionid,
      uid: ACCOUNT.uid,
      cookie: ACCOUNT.cookie,
      h5Cookie: ACCOUNT.h5Cookie,
      h5Token: ACCOUNT.h5Token,
      qwhdSession: ACCOUNT.qwhdSession,
      qwhdSessionAt: ACCOUNT.qwhdSessionAt || Date.now(),
      ssoJwt: ACCOUNT.ssoJwt,
      activityId: ACCOUNT.activityId,
      provinceCode: ACCOUNT.provinceCode,
      cityCode: ACCOUNT.cityCode,
      ticketId: ACCOUNT.ticketId,
      updatedAt: Date.now(),
      source: "qwhd-session-persist"
    }, true);
  } catch (e) {}
}

function shortBody(t) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > 100 ? s.slice(0, 97) + "..." : s;
}

/********************* 动态签到：可配置 H5/App 端点 *********************/
function LiveEndpointSign(s) {
  merge.AppSign = {};
  return new Promise(resolve => {
    setTimeout(async () => {
      try {
        // 主路径 LiveQwhdSign 已覆盖 mark31/domark，避免学习端点二次盲打
        const points = resolveSignEndpoints().filter(x => {
          if (!x || x.enabled === false || !isActionSignUrl(x.url)) return false;
          if (/wx\.10086\.cn\/qwhdhub\/api\/mark\/mark31\/domark/i.test(x.url)) return false;
          return true;
        });
        if (!points.length) {
          merge.AppSign.notify = "无可执行附加明文动作端点（主路径已由签到领奖处理）";
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
  // 明确黑名单：查询 / 状态 / 登录 / 配置 / 云盘 ycloud 已由 LiveCloudSign 专管
  if (/deployenvi|sdauth|sdkauth|domain\/login|tasklist|commoninfo|markstatus|mytaskinfo|checkexclusive|appcenterfloorrule|appcentercontactinfo|getconfiguration|refreshsession|bytoken\/multi|logreport|user\/info|monthinfo/i.test(u)) return false;
  if (/ycloud\/|m\.mcloud\.139\.com|querySpecToken|tyrzLogin|pointsNotClaimed|infoV3|doTaskPost/i.test(u)) return false;
  if (/\/login|\/auth|\/token|\/config|\/status|\/info|\/list|\/query|\/detail|\/router/i.test(u) && !/do[a-z]*sign|dosign|signin|domark|receivemark|checkin|taskaward/i.test(u)) return false;
  // 动作白名单：真实动作为 mark31/domark（全小写）
  if (/\/mark\/mark31\/domark(?:\/|$|\?)/i.test(u)) return true;
  if (/\/(doSign|signin|signIn|sign_in|checkIn|checkin|doMark|domark|mark\/mark(?:31)?\/(?:do)?mark|receive|clockIn|dailySign|taskAward)(?:\/|$|\?)/i.test(u)) return true;
  if (/qwhdhub\/api\/mark\/.*(?:domark|doMark|doSign|sign|receive|taskAward)/i.test(u)) return true;
  if (/(doSign|signin|sign_in|checkIn|qiandao|domark)/i.test(u) && !/(status|info|list|query|config|login)/i.test(u)) return true;
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
        else if (lk === "date") obj[k] = yyyymmdd(); // domark 用 yyyyMMdd，不是时间戳
        else if (/time|timestamp|_t|ts/.test(lk)) obj[k] = ts;
        else if (/nonce|random/.test(lk)) obj[k] = nonce;
        else if (/token|jsession|uid/.test(lk)) obj[k] = account.qwhdSession || account.h5Token || account.xtoken || account.jsessionid || account.uid || "";
        else if (/client|channel|source|from/.test(lk)) obj[k] = /channel|source|from/.test(lk) ? "cmcc-app" : "app";
        else obj[k] = ""; // 未知字段置空，避免回放旧值
      });
      // qwhdhub 动作接口优先使用 H5 会话头
      if (/wx\.10086\.cn\/qwhdhub/i.test(url)) {
        const qh = buildQwhdApiHeaders(url);
        headers = Object.assign(headers, qh);
      }
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
      // 主路径成功时，subtitle 强调主结果，避免辅路径失败主导观感
      const mainOk = !!(merge.QwhdSign && merge.QwhdSign.success);
      const cloudOk = !!(merge.CloudSign && merge.CloudSign.success);
      const subtitle = mainOk
        ? (fail ? `签到领奖成功（其它 ${fail} 项可忽略）` : (cloudOk ? "签到领奖+云盘成功" : "签到领奖成功"))
        : (cloudOk && !fail ? "云盘签到成功" : `成功${ok} / 失败${fail}`);
      const message = lines.filter(Boolean).join("\n") || "无结果";
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
    if (!n.phone && !n.uid && !n.jsessionid && !n.cloudAuthorization && !n.cloudSsoToken && !n.cloudJwt && !n.h5Cookie) return;
    const key = n.phone || n.uid || n.jsessionid || ("cloud:" + (n.cloudAuthorization || n.cloudSsoToken || n.cloudJwt || "").slice(-12));
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
    "phone", "cookie", "jsessionid", "uid", "xtoken", "userAgent", "appVersion",
    "cloudAuthorization", "noteToken", "appNumber", "cloudUA",
    "cloudSsoToken", "cloudJwt", "cloudDeviceId", "cloudAutoAt",
    "h5Cookie", "h5Token", "h5UA", "qwhdSession", "ssoJwt",
    "ticketId", "provinceCode", "cityCode", "carrierOperator",
    "activityId", "channelId", "yx", "userCheckId", "source"
  ].forEach(k => {
    // cloudSsoToken / cloudJwt 允许写空串（单次票消费后必须清）
    if (k === "cloudSsoToken" || k === "cloudJwt") {
      if (neo[k] !== undefined && neo[k] !== null) o[k] = neo[k];
      return;
    }
    if (neo[k] !== undefined && neo[k] !== null && neo[k] !== "") o[k] = neo[k];
  });
  if (neo.qwhdSessionAt) o.qwhdSessionAt = neo.qwhdSessionAt;
  if (neo.cloudAutoAt) o.cloudAutoAt = neo.cloudAutoAt;
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
  if (!n.phone && !n.uid && !n.jsessionid && !n.cloudAuthorization && !n.cloudSsoToken && !n.cloudJwt && !n.h5Cookie) {
    return n;
  }
  let idx = -1;
  if (n.phone) idx = list.findIndex(x => x.phone && x.phone === n.phone);
  if (idx < 0 && n.uid) idx = list.findIndex(x => x.uid && x.uid === n.uid);
  if (idx < 0 && n.jsessionid) idx = list.findIndex(x => x.jsessionid && x.jsessionid === n.jsessionid);
  // 云盘 Basic 后缀粗匹配（同号刷新 token）
  if (idx < 0 && n.cloudAuthorization) {
    const tail = String(n.cloudAuthorization).slice(-24);
    idx = list.findIndex(x => x.cloudAuthorization && String(x.cloudAuthorization).slice(-24) === tail);
  }
  if (idx >= 0) list[idx] = mergeAccount(list[idx], n);
  else {
    // 无合法 phone 时，不要新建“假号”账号（除非有 session / 云盘凭证+号）
    if (!n.phone && !n.uid && !n.jsessionid) return n;
    list.push(n);
    idx = list.length - 1;
  }
  saveAccounts(list);
  if (!silent && LogDetails) console.log("account upsert =>", maskPhone(list[idx].phone || list[idx].uid || ""));
  return list[idx];
}

function findAccountByPhone(phone) {
  const p = sanitizePhone(phone);
  if (!isValidPhone(p)) return null;
  return loadAccounts().find(a => a.phone === p) || null;
}

function reloadAccount(acc) {
  const n = normalizeAccount(acc || {});
  const list = loadAccounts();
  if (n.phone) {
    const byPhone = list.find(a => a.phone === n.phone);
    if (byPhone) return normalizeAccount(byPhone);
  }
  if (n.uid) {
    const byUid = list.find(a => a.uid === n.uid);
    if (byUid) return normalizeAccount(byUid);
  }
  if (n.jsessionid) {
    const byJs = list.find(a => a.jsessionid === n.jsessionid);
    if (byJs) return normalizeAccount(byJs);
  }
  return n.cookie || n.jsessionid || n.qwhdSession ? n : null;
}

/********************* HTTP 封装 *********************/
function httpJson(method, url, headers, data) {
  return httpRaw(method, url, headers, data == null ? null : JSON.stringify(data)).then(r => {
    // 统一去掉代理/chunk 包装，再 parse
    if (r && typeof r.body === "string") r.body = stripChunkPrefix(r.body);
    if (r.error) throw new Error(r.error);
    if (!r.body) return { status: r.status, empty: true, headers: r.headers || {} };
    try {
      const j = JSON.parse(r.body);
      if (j && typeof j === "object" && j.status == null) j.status = r.status;
      return j;
    } catch (e) {
      return { raw: r.body, status: r.status, headers: r.headers || {} };
    }
  });
}

function httpRaw(method, url, headers, body) {
  return new Promise(resolve => {
    const m = (method || "GET").toUpperCase();
    // 对 SSO/活动页禁用自动跳转，才能读到 302 Location 与 Set-Cookie
    // QX: opts.redirection = false；Surge/Loon: auto-redirect = false
    const opts = {
      url: url,
      method: m,
      headers: headers || {},
      "auto-redirect": false,
      opts: { redirection: false }
    };
    if (m !== "GET" && body != null) opts.body = body;

    let finished = false;
    const finish = (v) => { if (!finished) { finished = true; resolve(v); } };
    const timer = setTimeout(() => finish({ error: "timeout", status: 0, body: "", headers: {} }), out);

    const cb = (error, response, data) => {
      clearTimeout(timer);
      if (error) {
        const errStr = typeof error === "object"
          ? (error.error || error.message || JSON.stringify(error))
          : String(error);
        const st = response ? (response.status || response.statusCode || 0) : 0;
        const b = data != null ? data : (response && response.body) || "";
        return finish({ error: errStr, status: st, body: b || "", headers: (response && (response.headers || response.header)) || {} });
      }
      const status = response ? (response.status || response.statusCode || 0) : 0;
      const respHeaders = (response && (response.headers || response.header)) || {};
      const bodyOut = data != null ? data : (response && response.body) || "";
      finish({ status: status, body: bodyOut, error: null, headers: respHeaders, url: url });
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
  const s = String(text || "");
  // 避免 prizeType:1 / prizeLevel:1 被当成奖励数量
  if (/"prizeName"\s*:\s*"([^"]+)"/.test(s)) return "";
  const m = s.match(/(?:奖励|积分|金币|云朵|流量)[^\d]{0,8}(\d+(?:\.\d+)?)\s*(?:MB|GB|元|分|个)?/i);
  return m ? (m[1] + (m[0].match(/MB|GB|元|分|个/i) ? m[0].match(/MB|GB|元|分|个/i)[0] : "")) : "";
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
  const ticket = matchOne(text, /ticketID=([^;,\s]+)/i);
  if (!jsid) return "";
  let c = `JSESSIONID=${jsid}`;
  if (uid) c += `; UID=${uid}`;
  // appTokenLogin 需要完整形态（ticketID 因省而异，如 ShanDong）
  if (ticket) c += `; Comment=SessionServer-unity; Path=/;HTTPOnly; ticketID=${ticket}; Secure`;
  return c;
}

function extractPhoneLoose() {
  // 兼容旧调用；内部改走严格规则
  return extractPhoneStrict.apply(null, arguments);
}

// 严格提取手机号：优先字段语义，过滤时间戳伪号 / CDN 图链伪号
function extractPhoneStrict() {
  const parts = Array.prototype.slice.call(arguments).map(x => {
    try { return typeof x === "string" ? x : JSON.stringify(x); } catch (e) { return String(x); }
  });
  // 先抹掉 URL / 图片文件名中的长数字，避免 m_upload_4941363282224798429.png → 13632822247
  let blob = parts.join("\n")
    .replace(/https?:\/\/[^\s"'<>]+/gi, " ")
    .replace(/m_upload_\d+/gi, " ")
    .replace(/\/[\w.-]*\d{10,}[\w.-]*\.(?:png|jpg|jpeg|gif|webp|css|js)/gi, " ");

  // 1) 字段语义优先（不要扫 advertisingImg/statusImg 等）
  const named = [
    /(?:phone|mobile|msisdn|tel|app_number|appNumber|mobilePhone)["'=\s:]*?(1[3-9]\d{9})/ig,
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

  // 3) taskAward uuid: AvnWN13873381269...（明确业务字段，可用）
  const uuidPhone = matchOne(blob, /AvnWN(1[3-9]\d{9})/i);
  if (uuidPhone && isValidPhone(uuidPhone)) return uuidPhone;

  // 4) 裸 11 位兜底：进一步排除 CDN / 文件名 / 时间戳
  // 注意：默认关闭“从任意 JSON 扫号”，幽灵号大多来自这里
  if (!AllowBarePhoneFallback) return "";
  const all = blob.match(/1[3-9]\d{9}/g) || [];
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    if (!isValidPhone(p)) continue;
    const idx = blob.indexOf(p);
    const around = blob.slice(Math.max(0, idx - 28), idx + 24).toLowerCase();
    if (/time|timestamp|currenttime|nonce|token|_t=|date|expires|expire|upload|m_upload|\.png|\.jpg|cdn|img|src|advertis|statusimg|prize/.test(around)) continue;
    // 前后若仍是数字，说明嵌在更长数字串中（CDN id 切片）
    const prev = idx > 0 ? blob[idx - 1] : "";
    const next = blob[idx + 11] || "";
    if (/\d/.test(prev) || /\d/.test(next)) continue;
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
  // 虚拟/特殊号段在本脚本场景几乎都是 CDN 截取误报（165/167/170 等）
  if (/^16[5-7]/.test(p)) return false;
  return true;
}

// 可执行签到的账号：App 会话（签到领奖）或云盘凭证（ycloud 签到）
function isRunnableAccount(a) {
  if (!a) return false;
  if (a.phone && !isValidPhone(a.phone) && !a.uid && !a.jsessionid && !a.cloudAuthorization && !a.cloudSsoToken && !a.cloudJwt) return false;
  if (a.jsessionid || (a.cookie && /JSESSIONID=/i.test(a.cookie))) return true;
  // 纯云盘账号：打开移动云盘后可独立跑云盘签到
  if (EnableCloudSign && (a.cloudAuthorization || a.cloudSsoToken || a.cloudJwt) && isValidPhone(a.phone)) return true;
  return false;
}

function purgeGhostAccounts() {
  try {
    const list = loadAccounts();
    const kept = list.filter(a => {
      if (!a) return false;
      // 只有伪手机号、无任何会话
      if (a.phone && !isValidPhone(a.phone) && !a.uid && !a.jsessionid && !a.cookie) return false;
      if (!a.uid && !a.jsessionid && !a.cookie && !a.qwhdSession && !a.cloudAuthorization && !a.cloudSsoToken && !a.cloudJwt) return false;
      // 只有手机号、无会话 → 幽灵
      if (a.phone && !a.uid && !a.jsessionid && !a.cookie && !a.qwhdSession && !a.cloudAuthorization && !a.cloudSsoToken && !a.cloudJwt) return false;
      return true;
    });
    if (kept.length !== list.length) {
      saveAccounts(kept);
      console.log("purgeGhostAccounts => removed", list.length - kept.length, "kept", kept.length);
    }
  } catch (e) {}
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

/** QX 控制台多参数 console.log 会丢后续参数，统一拼成单字符串 */
function clog() {
  try {
    const s = Array.prototype.map.call(arguments, x => {
      if (x == null) return "";
      if (typeof x === "object") {
        try { return JSON.stringify(x); } catch (e) { return String(x); }
      }
      return String(x);
    }).join(" ");
    console.log(s);
  } catch (e) {
    try { console.log(String(arguments[0])); } catch (e2) {}
  }
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
