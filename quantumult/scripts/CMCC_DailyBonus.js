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

// 自动学习到的端点是否在下次签到时启用
var AutoUseLearnedEndpoints = true;
// 学习到端点后是否立刻用「本次会话」触发一次动态签到
var AutoSignAfterLearn = true;

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
    GetCookie().then(() => $nobyda.done()).catch(e => {
      console.log("GetCookie error: " + e);
      $nobyda.done();
    });
    return;
  }

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
    LiveEndpointSign(0)
  ]);

  await notify(tag);
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
      phone: extractPhoneLoose(body, respBody, headers, setCookie),
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
        phone: extractPhoneLoose(body, respBody, headers),
        cookie: cookie,
        jsessionid: matchOne(cookie, /JSESSIONID=([^;]+)/i),
        uid: matchOne(cookie, /UID=([^;]+)/i),
        xtoken: getHeader(headers, "x-token") || getHeader(headers, "X-Token") || "",
        userAgent: getHeader(headers, "User-Agent") || "",
        updatedAt: Date.now(),
        source: "session-refresh"
      }, true);
    }
  }

  // 3) 云盘/笔记 Authorization —— 每次登录后的新凭证，现场入库，并可立刻签到
  if (/caiyun\.feixin\.10086\.cn|yun\.139\.com|mcloud\.139\.com|vsbo\.caiyun/i.test(url)) {
    const auth = getHeader(headers, "Authorization") || getHeader(headers, "APP_AUTH") || "";
    if (/Basic\s+/i.test(auth)) {
      const phone = decodeBasicPhone(auth) || extractPhoneLoose(body, respBody, headers);
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

      // 如果是登录后不久的云盘鉴权刷新，直接用新凭证签一次
      if (AutoSignAfterLogin && saved.cloudAuthorization) {
        ACCOUNT = normalizeAccount(saved);
        merge = {};
        await LiveCloudSign(0);
        await notify(maskPhone(ACCOUNT.phone || "云盘账号") + "·云盘即时签到");
      } else {
        $nobyda.notify("中国移动", "云盘凭证已更新", maskPhone(phone || "账号"));
      }
    }
  }

  // 4) 自动学习 H5 / 明文疑似签到接口（只存模板，不固化 body）
  //    触发条件：URL/响应包含 sign/checkIn/签到 等关键字，且 body 看起来是明文 JSON/form
  if (looksLikeSignEndpoint(url, body, respBody, headers)) {
    // 仅在响应阶段确认业务语义更可靠；请求阶段也可先入库模板
    const learned = learnSignEndpoint({
      url: url,
      method: ($request.method || "POST").toUpperCase(),
      headers: headers,
      body: body,
      respBody: respBody
    });
    if (learned && learned.added) {
      $nobyda.notify("中国移动", "已学习签到接口(动态模板)", learned.point.name + "\n" + shortUrl(learned.point.url));
      if (AutoSignAfterLearn) {
        // 同步刷新会话字段，并优先用「当前请求所属账号」触发，避免误签到第一个账号
        const cookie = pickSessionCookie(getHeader(headers, "Cookie"));
        const phone = extractPhoneLoose(body, respBody, headers);
        let acc = null;
        if (cookie || phone) {
          acc = upsertAccount({
            phone: phone,
            cookie: cookie,
            jsessionid: matchOne(cookie, /JSESSIONID=([^;]+)/i),
            uid: matchOne(cookie, /UID=([^;]+)/i),
            xtoken: getHeader(headers, "x-token") || getHeader(headers, "X-Token") || "",
            userAgent: getHeader(headers, "User-Agent") || "",
            updatedAt: Date.now(),
            source: "sign-learn"
          }, true);
        } else {
          const list = loadAccounts();
          acc = list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || {};
        }
        if (SignDelayMs > 0) await wait(SignDelayMs);
        await all(acc, { reason: "learn-trigger" });
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

/********************* 动态签到：可配置 H5/App 端点 *********************/
function LiveEndpointSign(s) {
  merge.AppSign = {};
  return new Promise(resolve => {
    setTimeout(async () => {
      try {
        const points = resolveSignEndpoints().filter(x => x && x.enabled !== false);
        if (!points.length) {
          merge.AppSign.notify = "未配置/未学习到明文签到端点。App 原生密文签到无法动态伪造；请点一次「立即签到」让脚本学习，或继续用云盘动态签到。";
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
  if (!AutoUseLearnedEndpoints) return staticPoints;
  const learned = loadLearnedEndpoints();
  const map = {};
  staticPoints.concat(learned).forEach(p => {
    if (!p || !p.url) return;
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

function looksLikeSignEndpoint(url, reqBody, respBody, headers) {
  const u = String(url || "");
  if (!u) return false;
  // 排除纯静态/日志/监控
  if (/\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?)(\?|$)/i.test(u)) return false;
  if (/dnlog\.|logReport|collect|beacon|sensors|umeng|tingyun|hubble/i.test(u)) return false;
  // 原生密文接口即使路径像 sign 也学不到可复用 body
  if (/x-sign|x-qen/i.test(JSON.stringify(headers || {})) && isLikelyCipherBody(reqBody)) {
    // 若响应本身明文且含签到语义，仍可学习 URL 模板
    if (!looksLikePlainSignResponse(respBody)) return false;
  }

  const urlHit = /sign|signin|sign_in|doSign|checkIn|checkin|qiandao|clockIn|dailySign|签到/i.test(u);
  const bodyHit = /签到|已签|signin|signIn|doSign|checkIn|todaySign|sign_in|签到成功|领取成功/i.test(String(reqBody || "") + "\n" + String(respBody || ""));
  const ct = String(getHeader(headers, "Content-Type") || "");
  const plainish = /json|x-www-form-urlencoded|text\/plain|text\/html/i.test(ct) || looksLikePlainBody(reqBody) || looksLikePlainSignResponse(respBody);
  return (urlHit || bodyHit) && plainish;
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
    const key = n.phone || n.uid || n.jsessionid;
    if (!key || seen.has(key)) {
      if (key && seen.has(key)) {
        const idx = out.findIndex(x => (x.phone && x.phone === n.phone) || (x.uid && x.uid === n.uid) || (x.jsessionid && x.jsessionid === n.jsessionid));
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
  o.phone = String(o.phone || "").replace(/\D/g, "");
  o.jsessionid = o.jsessionid || matchOne(o.cookie || "", /JSESSIONID=([^;]+)/i);
  o.uid = o.uid || matchOne(o.cookie || "", /UID=([^;]+)/i);
  // 明确丢弃旧版固化 tasks，避免被误用
  if (o.tasks) delete o.tasks;
  return o;
}

function mergeAccount(oldItem, neo) {
  const o = Object.assign({}, oldItem);
  [
    "phone", "cookie", "jsessionid", "uid", "xtoken", "userAgent",
    "cloudAuthorization", "noteToken", "appNumber", "cloudUA", "source"
  ].forEach(k => { if (neo[k]) o[k] = neo[k]; });
  o.updatedAt = neo.updatedAt || Date.now();
  if (o.tasks) delete o.tasks;
  return o;
}

function upsertAccount(item, silent) {
  const list = loadAccounts();
  const n = normalizeAccount(item);
  let idx = list.findIndex(x =>
    (n.phone && x.phone === n.phone) ||
    (n.uid && x.uid === n.uid) ||
    (n.jsessionid && x.jsessionid === n.jsessionid)
  );
  if (idx >= 0) list[idx] = mergeAccount(list[idx], n);
  else {
    list.push(n);
    idx = list.length - 1;
  }
  saveAccounts(list);
  if (!silent) console.log("account upsert =>", maskPhone(list[idx].phone || list[idx].uid || ""));
  return list[idx];
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
  const blob = Array.prototype.slice.call(arguments).map(x => {
    try { return typeof x === "string" ? x : JSON.stringify(x); } catch (e) { return String(x); }
  }).join("\n");
  const m = blob.match(/mobile:?([1][3-9]\d{9})/i) || blob.match(/(1[3-9]\d{9})/);
  if (!m) return "";
  const p = m[1];
  if (/^1786491/.test(p) || /^1403535/.test(p) || /^1411431/.test(p)) return "";
  return p;
}

function decodeBasicPhone(auth) {
  try {
    const m = String(auth).match(/Basic\s+([A-Za-z0-9+/=]+)/i);
    if (!m) return "";
    const dec = base64Decode(m[1]);
    const p = dec.match(/1[3-9]\d{9}/);
    return p ? p[0] : "";
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
