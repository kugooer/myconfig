/*************************

  比亚迪海洋网微信小程序 每日签到脚本 (BYDMina_DailyBonus)

  更新时间: 2026-09-09 (capture-v1)
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  协议（逆向自小程序 wxf62054ec313d6f53，详见 BYD_MINI_PROTOCOL.md）:
    网关     https://mina.bydoceanauto.com?service=Forward2Rights.task&serviceDir=<API>
    签到     serviceDir=/Activity/SignIn/SignIn          body {session_id, date:"", isCard:0}
    日历     serviceDir=/Activity/SignIn/getSignCalendar body {session_id}
    头部     Appkey: hyMinaApi
             Nonce: 16位随机 / Curtime: 秒级时间戳
             Checksum: sha256hex("Kfl%BOk6C5PwARw8" + Nonce + Curtime)
             x-clienttraceid: mina-<uuid>
    请求/响应 AES-128-CBC-PKCS7(key=3993014457161851, iv=PDVcDRWMrBlLHTqh) base64

  凭证获取（自动）:
    挂载 rewrite 后，手机微信打开比亚迪小程序任意页面，
    script-request-body 解密请求体提取 session_id 持久化。
    session 过期后同样操作一次即自动续期。

  注意:
  - 仅自用账号签到凭证缓存；不含任何解锁类功能
  - QX JavaScriptCore 无 crypto，AES/SHA256 为内嵌纯 JS 实现（已与 Node crypto 对拍）

【推荐挂载 · Quantumult X】
----------------
重写引用:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/BYDMina_DailyBonus.conf

任务引用:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/BYDMina_DailyBonus.task

脚本本体:
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYDMina_DailyBonus.js

获取凭证: 手机微信打开比亚迪小程序（我的→签到）→ 自动捕获通知
*************************/

var LogDetails = false;
var DeleteCookie = false;
var Notify = true;
var out = 0;

var PREFIX = "BYDMina";
var GATEWAY = "https://mina.bydoceanauto.com?service=Forward2Rights.task";
var API_SIGN = "/Activity/SignIn/SignIn";
var API_CAL = "/Activity/SignIn/getSignCalendar";
var APP_KEY = "hyMinaApi";
var APP_SECRET = "Kfl%BOk6C5PwARw8";
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.49";

var KEY_COOKIE = PREFIX + "_Cookies";      // {session_id, capturedAt, expiredAt}
var KEY_DIAG = PREFIX + "_CaptureDiag";

var $nobyda = nobyda(); // 必须在 PREFIX 等常量之后初始化（nodeFile 依赖 PREFIX）


// ===================== 凭证捕获（rewrite 入口） =====================

async function GetCookie() {
  var body = $nobyda.requestBody;
  if (!body) { consoleLog("capture: empty body"); return; }
  var plain;
  try { plain = AESDecryptStr(body.trim()); }
  catch (e) { consoleLog("capture: decrypt fail " + (e.stack || e.message)); return; }
  if (!plain || !plain.session_id) {
    consoleLog("capture: no session_id in " + JSON.stringify(plain).slice(0, 120));
    return;
  }
  var old = readJSON(KEY_COOKIE);
  var rec = {
    session_id: String(plain.session_id),
    capturedAt: nowCN(),
    expiredAt: plain.expired_timestamp ? tsCN(plain.expired_timestamp) : "未知",
  };
  $nobyda.write(JSON.stringify(rec), KEY_COOKIE);
  $nobyda.write(nowCN() + " bodyLen=" + body.length, KEY_DIAG);

  if (!old || !old.session_id) {
    $nobyda.notify("比亚迪小程序签到", "凭证已捕获 ✅", "session 有效期至 " + rec.expiredAt + "，任务将自动签到");
  } else if (old.session_id !== rec.session_id) {
    consoleLog("capture: session updated (silent)");
  } else {
    consoleLog("capture: session unchanged (silent)");
  }
}

// ===================== 签到主流程 =====================

async function doSignIn() {
  var ck = readJSON(KEY_COOKIE);
  if (!ck || !ck.session_id) {
    $nobyda.notify("比亚迪小程序签到", "无凭证 ⚠️", "请挂载重写后，用手机微信打开比亚迪小程序签到页抓取");
    out = 1;
    return;
  }

  // 1) 查日历（校验 session + 判断当日已签）
  var cal;
  try {
    cal = await apiCall(API_CAL, { session_id: ck.session_id });
  } catch (e) {
    $nobyda.notify("比亚迪小程序签到", "请求异常 ❌", e.message || String(e));
    out = 1;
    return;
  }
  consoleLog("calendar ret=" + cal.ret + " " + JSON.stringify(cal.data || {}).slice(0, 160));

  var cls = classify(cal);
  if (cls.state === "expired") {
    $nobyda.notify("比亚迪小程序签到", "凭证已过期 ⚠️", "打开微信小程序任意页面即自动续期（捕获于 " + ck.capturedAt + "）");
    out = 1;
    return;
  }
  if (cls.state === "done") {
    if (Notify) $nobyda.notify("比亚迪小程序签到", "今日已签到 ☑️", cls.text);
    return;
  }
  if (cls.state === "fail") {
    $nobyda.notify("比亚迪小程序签到", "查日历失败 ❌", cls.text);
    out = 1;
    return;
  }

  // 2) 签到
  var sign = await apiCall(API_SIGN, { session_id: ck.session_id, date: "", isCard: 0 });
  consoleLog("signIn ret=" + sign.ret + " " + JSON.stringify(sign.data || {}).slice(0, 200));

  var s2 = classify(sign);
  if (s2.state === "done") {
    if (Notify) $nobyda.notify("比亚迪小程序签到", "今日已签到 ☑️", s2.text);
  } else if (s2.state === "ok") {
    if (Notify) $nobyda.notify("比亚迪小程序签到", "签到成功 ✅", s2.text);
  } else if (s2.state === "expired") {
    $nobyda.notify("比亚迪小程序签到", "凭证已过期 ⚠️", "打开微信小程序任意页面即自动续期");
    out = 1;
  } else {
    $nobyda.notify("比亚迪小程序签到", "签到失败 ❌", s2.text);
    out = 1;
  }
}

function classify(r) {
  var d = r && r.data;
  if (r && r.ret === 200) {
    if (d && d.duplicate) return { state: "done", text: "服务端判定当日已签" };
    if (d && typeof d.todayIndex === "number" && d.todayIndex >= 0) return { state: "done", text: "今日已签（日历 todayIndex=" + d.todayIndex + "）" };
    if (d && (d.integral !== undefined || d.durationDays !== undefined)) {
      return { state: "ok", text: d.rewardMsg || ("已连续签到" + d.durationDays + "天，+" + d.integral + "积分") };
    }
    return { state: "ok", text: "ret=200" };
  }
  if (r && (r.ret === 21017 || r.ret === 401)) return { state: "expired", text: "ret=" + r.ret };
  if (r && r.ret === 400 && /uid/.test(r.msg || "")) return { state: "expired", text: "session 无法解析用户（已过期）" };
  return { state: "fail", text: "ret=" + (r && r.ret) + " " + ((r && r.msg) || "未知") };
}

// ===================== 协议请求 =====================

async function apiCall(serviceDir, payload) {
  var nonce = randStr(16);
  var curtime = String(Math.floor(Date.now() / 1000));
  var checksum = SHA256(APP_SECRET + nonce + curtime);
  var headers = {
    "Content-Type": "application/json",
    "Appkey": APP_KEY,
    "Nonce": nonce,
    "Curtime": curtime,
    "Checksum": checksum,
    "x-clienttraceid": "mina-" + uuid(),
    "User-Agent": UA,
  };
  var body = AESEncryptStr(JSON.stringify(payload));
  var opts = { url: GATEWAY + "&serviceDir=" + serviceDir, method: "POST", headers: headers, body: body };
  var resp = await $nobyda.fetch(opts);
  consoleLog("HTTP " + resp.status + " " + serviceDir);
  var raw = String(resp.body || "").trim();
  if (raw.indexOf("{") === 0) return safeJSON(raw); // 网关层错误为明文 JSON
  return AESDecryptStr(raw);                        // 业务响应为加密 base64
}

function readJSON(key) {
  var v = $nobyda.read(key);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
function safeJSON(s) { try { return JSON.parse(s); } catch (e) { return { ret: -1, msg: "非JSON响应: " + String(s).slice(0, 80) }; } }
function nowCN() { return tsCN(Math.floor(Date.now() / 1000)); }
function tsCN(sec) {
  var d = new Date((Number(sec) + 8 * 3600) * 1000); // QX JSC 时区=UTC，强制东八区
  var p = function (n) { return n < 10 ? "0" + n : "" + n; };
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}
function randStr(n) {
  var cs = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", s = "";
  for (var i = 0; i < n; i++) s += cs.charAt(Math.floor(Math.random() * cs.length));
  return s;
}
function uuid() {
  var s = randStr(32).toLowerCase().replace(/[^a-f0-9]/g, "0");
  return s.slice(0, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16) + "-" + s.slice(16, 20) + "-" + s.slice(20, 32);
}
function consoleLog(m) { if (LogDetails) console.log("[BYDMina] " + m); }

// ===================== 纯 JS AES-128-CBC-PKCS7（QX 无 crypto，已与 Node 对拍） =====================

var AES_SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
var AES_ISBOX = [
  0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,
  0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,
  0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc3,0x4e,
  0x08,0x2e,0xa1,0x66,0x28,0xd9,0x24,0xb2,0x76,0x5b,0xa2,0x49,0x6d,0x8b,0xd1,0x25,
  0x72,0xf8,0xf6,0x64,0x86,0x68,0x98,0x16,0xd4,0xa4,0x5c,0xcc,0x5d,0x65,0xb6,0x92,
  0x6c,0x70,0x48,0x50,0xfd,0xed,0xb9,0xda,0x5e,0x15,0x46,0x57,0xa7,0x8d,0x9d,0x84,
  0x90,0xd8,0xab,0x00,0x8c,0xbc,0xd3,0x0a,0xf7,0xe4,0x58,0x05,0xb8,0xb3,0x45,0x06,
  0xd0,0x2c,0x1e,0x8f,0xca,0x3f,0x0f,0x02,0xc1,0xaf,0xbd,0x03,0x01,0x13,0x8a,0x6b,
  0x3a,0x91,0x11,0x41,0x4f,0x67,0xdc,0xea,0x97,0xf2,0xcf,0xce,0xf0,0xb4,0xe6,0x73,
  0x96,0xac,0x74,0x22,0xe7,0xad,0x35,0x85,0xe2,0xf9,0x37,0xe8,0x1c,0x75,0xdf,0x6e,
  0x47,0xf1,0x1a,0x71,0x1d,0x29,0xc5,0x89,0x6f,0xb7,0x62,0x0e,0xaa,0x18,0xbe,0x1b,
  0xfc,0x56,0x3e,0x4b,0xc6,0xd2,0x79,0x20,0x9a,0xdb,0xc0,0xfe,0x78,0xcd,0x5a,0xf4,
  0x1f,0xdd,0xa8,0x33,0x88,0x07,0xc7,0x31,0xb1,0x12,0x10,0x59,0x27,0x80,0xec,0x5f,
  0x60,0x51,0x7f,0xa9,0x19,0xb5,0x4a,0x0d,0x2d,0xe5,0x7a,0x9f,0x93,0xc9,0x9c,0xef,
  0xa0,0xe0,0x3b,0x4d,0xae,0x2a,0xf5,0xb0,0xc8,0xeb,0xbb,0x3c,0x83,0x53,0x99,0x61,
  0x17,0x2b,0x04,0x7e,0xba,0x77,0xd6,0x26,0xe1,0x69,0x14,0x63,0x55,0x21,0x0c,0x7d];
var AES_RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

function aesXtime(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; }
function aesGmul(a, b) {
  var r = 0;
  while (b) { if (b & 1) r ^= a; a = aesXtime(a); b >>= 1; }
  return r & 0xff;
}
function aesExpandKey(key) { // key: byte[16] -> roundkeys byte[176]
  var w = key.slice(0, 16), rcon = 0, i, j, t;
  for (i = 16; i < 176; i += 4) {
    t = [w[i - 4], w[i - 3], w[i - 2], w[i - 1]];
    if (i % 16 === 0) {
      t = [AES_SBOX[t[1]] ^ AES_RCON[rcon++], AES_SBOX[t[2]], AES_SBOX[t[3]], AES_SBOX[t[0]]];
    }
    for (j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
  }
  return w;
}
function aesAddRK(s, w, off) { for (var i = 0; i < 16; i++) s[i] ^= w[off + i]; }
function aesShiftRows(s) {
  var t;
  t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
  t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
  t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
}
function aesInvShiftRows(s) {
  var t;
  t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
  t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
  t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
}
function aesMixCol(c) { // c: byte[4]
  var a0 = c[0], a1 = c[1], a2 = c[2], a3 = c[3];
  c[0] = aesGmul(a0, 2) ^ aesGmul(a1, 3) ^ a2 ^ a3;
  c[1] = a0 ^ aesGmul(a1, 2) ^ aesGmul(a2, 3) ^ a3;
  c[2] = a0 ^ a1 ^ aesGmul(a2, 2) ^ aesGmul(a3, 3);
  c[3] = aesGmul(a0, 3) ^ a1 ^ a2 ^ aesGmul(a3, 2);
  return c;
}
function aesInvMixCol(c) {
  var a0 = c[0], a1 = c[1], a2 = c[2], a3 = c[3];
  c[0] = aesGmul(a0, 14) ^ aesGmul(a1, 11) ^ aesGmul(a2, 13) ^ aesGmul(a3, 9);
  c[1] = aesGmul(a0, 9) ^ aesGmul(a1, 14) ^ aesGmul(a2, 11) ^ aesGmul(a3, 13);
  c[2] = aesGmul(a0, 13) ^ aesGmul(a1, 9) ^ aesGmul(a2, 14) ^ aesGmul(a3, 11);
  c[3] = aesGmul(a0, 11) ^ aesGmul(a1, 13) ^ aesGmul(a2, 9) ^ aesGmul(a3, 14);
  return c;
}
function aesEncBlock(input, w) {
  var s = input.slice(0, 16), c, r, i;
  aesAddRK(s, w, 0);
  for (r = 1; r <= 9; r++) {
    for (i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    aesShiftRows(s);
    for (c = 0; c < 4; c++) aesMixCol([s[c * 4], s[c * 4 + 1], s[c * 4 + 2], s[c * 4 + 3]]).forEach(function (v, j) { s[c * 4 + j] = v; });
    aesAddRK(s, w, r * 16);
  }
  for (i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
  aesShiftRows(s);
  aesAddRK(s, w, 160);
  return s;
}
function aesDecBlock(input, w) {
  var s = input.slice(0, 16), c, r, i;
  aesAddRK(s, w, 160);
  for (r = 9; r >= 1; r--) {
    aesInvShiftRows(s);
    for (i = 0; i < 16; i++) s[i] = AES_ISBOX[s[i]];
    aesAddRK(s, w, r * 16);
    for (c = 0; c < 4; c++) aesInvMixCol([s[c * 4], s[c * 4 + 1], s[c * 4 + 2], s[c * 4 + 3]]).forEach(function (v, j) { s[c * 4 + j] = v; });
  }
  aesInvShiftRows(s);
  for (i = 0; i < 16; i++) s[i] = AES_ISBOX[s[i]];
  aesAddRK(s, w, 0);
  return s;
}
function strBytes(s) { // UTF-8 -> byte[]
  var out = [], i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function bytesUtf8(b) { // byte[] -> UTF-8 string
  var s = "", i = 0;
  while (i < b.length) {
    var c = b[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 31) << 6) | (b[i++] & 63));
    else if (c < 0xf0) s += String.fromCharCode(((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63));
    else {
      var cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    }
  }
  return s;
}
var AES_KEYB = strBytes("3993014457161851");
var AES_IVB = strBytes("PDVcDRWMrBlLHTqh");
var AES_W = aesExpandKey(AES_KEYB);

function AESEncryptStr(plain) { // -> base64
  var data = strBytes(plain);
  var pad = 16 - (data.length % 16);
  for (var i = 0; i < pad; i++) data.push(pad);
  var out = [], prev = AES_IVB.slice(0, 16);
  for (var b = 0; b < data.length; b += 16) {
    var blk = [];
    for (var j = 0; j < 16; j++) blk.push(data[b + j] ^ prev[j]);
    var enc = aesEncBlock(blk, AES_W);
    out = out.concat(enc);
    prev = enc;
  }
  return btoaBytes(out);
}
function AESDecryptStr(b64) { // base64 -> JSON object
  var data = atobBytes(String(b64).replace(/\s/g, ""));
  if (data.length === 0 || data.length % 16 !== 0) throw new Error("bad ciphertext len " + data.length);
  var out = [], prev = AES_IVB.slice(0, 16);
  for (var b = 0; b < data.length; b += 16) {
    var blk = data.slice(b, b + 16);
    var dec = aesDecBlock(blk, AES_W);
    for (var j = 0; j < 16; j++) out.push(dec[j] ^ prev[j]);
    prev = blk;
  }
  var pad = out[out.length - 1];
  if (pad < 1 || pad > 16) throw new Error("bad padding " + pad);
  for (var k = out.length - pad; k < out.length; k++) if (out[k] !== pad) throw new Error("bad padding bytes");
  var json = bytesUtf8(out.slice(0, out.length - pad));
  return JSON.parse(json);
}
function btoaBytes(bytes) {
  var cs = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", r = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    r += cs[b0 >> 2] + cs[((b0 & 3) << 4) | (b1 >> 4)];
    r += i + 1 < bytes.length ? cs[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    r += i + 2 < bytes.length ? cs[b2 & 63] : "=";
  }
  return r;
}
function atobBytes(s) {
  var cs = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", out = [], buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var v = cs.indexOf(s.charAt(i));
    if (v < 0 || s.charAt(i) === "=") continue;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return out;
}

// ===================== 纯 JS SHA256（QX 无 crypto，已与 Node 对拍） =====================

var SHA_K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function SHA256(msg) {
  var bytes = strBytes(msg), i;
  var bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var w = new Array(64);
  function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
  for (var b = 0; b < bytes.length; b += 64) {
    for (i = 0; i < 16; i++) w[i] = (bytes[b + i * 4] << 24) | (bytes[b + i * 4 + 1] << 16) | (bytes[b + i * 4 + 2] << 8) | bytes[b + i * 4 + 3];
    for (i = 16; i < 64; i++) {
      var s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      var s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (i = 0; i < 64; i++) {
      var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + SHA_K[i] + w[i]) | 0;
      var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      var maj = (a & bb) ^ (a & c) ^ (bb & c);
      var t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  var hex = "";
  for (i = 0; i < 8; i++) hex += ("00000000" + ((H[i] >>> 0).toString(16))).slice(-8);
  return hex;
}

// ===================== nobyda 适配层（QX / Surge / Loon / Node） =====================

function nobyda() {
  var isNode = typeof require === "function" && typeof module !== "undefined" && typeof $task === "undefined";
  var isQuanX = typeof $task !== "undefined" && typeof $task.fetch === "function";
  var isSurge = typeof $httpClient !== "undefined" && !isQuanX;
  var isRequest = typeof $request !== "undefined" && !isNode;

  var nodeFile = (typeof __dirname !== "undefined" ? __dirname : ".") + "/" + PREFIX + "_cookie.json";
  function nodeRead() {
    try { return require("fs").readFileSync(nodeFile, "utf8"); } catch (e) { return ""; }
  }
  function nodeWrite(v) {
    try { require("fs").writeFileSync(nodeFile, typeof v === "string" ? v : ""); } catch (e) {}
  }
  function nodeStore() { try { return JSON.parse(nodeRead() || "{}"); } catch (e) { return {}; } }

  return {
    isRequest: isRequest,
    requestBody: isRequest ? ($request.body || "") : "",
    read: function (key) {
      if (isQuanX) return $prefs.valueForKey(key) || "";
      if (isSurge || typeof $persistentStore !== "undefined") return $persistentStore.read(key) || "";
      if (isNode) return nodeStore()[key] || "";
      return "";
    },
    write: function (val, key) {
      if (isQuanX) { $prefs.setValueForKey(val, key); return; }
      if (isSurge || typeof $persistentStore !== "undefined") { $persistentStore.write(val, key); return; }
      if (isNode) {
        var o = nodeStore();
        if (val) o[key] = val; else delete o[key];
        nodeWrite(JSON.stringify(o));
      }
    },
    notify: function (title, subtitle, body) {
      if (isQuanX) { $notify(title, subtitle, body); return; }
      if (isSurge || typeof $notification !== "undefined") { $notification.post(title, subtitle, body); return; }
      console.log("[NOTIFY] " + title + " | " + subtitle + " | " + body);
    },
    fetch: function (opts) {
      if (isQuanX) {
        return $task.fetch(opts).then(function (r) { return { status: r.status, body: r.body }; });
      }
      if (isSurge || typeof $httpClient !== "undefined") {
        return new Promise(function (resolve) {
          $httpClient.post({ url: opts.url, headers: opts.headers, body: opts.body }, function (err, resp) {
            resolve({ status: resp ? resp.status : 0, body: resp ? resp.body : "" });
          });
        });
      }
      // Node
      return new Promise(function (resolve, reject) {
        var https = require("https");
        var u = new URL(opts.url);
        var req = https.request({
          hostname: u.hostname, port: 443, path: u.pathname + u.search, method: "POST",
          headers: opts.headers, timeout: 20000,
        }, function (res) {
          var chunks = [];
          res.on("data", function (c) { chunks.push(c); });
          res.on("end", function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
        });
        req.on("error", reject);
        req.on("timeout", function () { req.destroy(new Error("timeout")); });
        req.write(opts.body);
        req.end();
      });
    },
    done: function () {
      if (isNode) return;
      if (typeof $done === "function") $done({ body: "", status: out === 0 ? 200 : 500 });
    },
  };
}

// ===================== 入口（双入口） =====================

(async () => {
  try {
    if (DeleteCookie) {
      [KEY_COOKIE, KEY_DIAG].forEach(function (k) { $nobyda.write("", k); });
      $nobyda.notify("比亚迪小程序签到", "", "已清除凭证，请重新打开小程序抓取 ‼️");
      return $nobyda.done();
    }

    if ($nobyda.isRequest) {
      await GetCookie();
    } else {
      await doSignIn();
    }
  } catch (e) {
    consoleLog("FATAL " + (e && (e.stack || e.message || e)));
    $nobyda.notify("比亚迪小程序签到", "脚本异常 ❌", (e && e.message) || String(e));
    out = 1;
  }
  $nobyda.done();
})();
