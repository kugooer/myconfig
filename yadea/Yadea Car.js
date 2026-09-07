// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: battery-half;

/**
 * 雅迪电动车状态 Widget（Scriptable）
 *
 * 数据来源：雅迪智造 App 内嵌 H5（tspapph5.yadeaiot.com.cn/prod-wg）网关。
 * 网关协议（已从 H5 前端 JS chunk-common 逆向确认）：
 *   1. gatewaySign = Base64(AES-128-ECB-PKCS7(`gatewayTimestamp=${ms}&json=${JSON.stringify(params)}`, key))
 *      key = prod.secret（16 字节，短于 16 字节右侧补 0x00）
 *   2. 请求头携带 gatewayAppId / gatewaySign / gatewayTimestamp，无 query、无 body
 *   3. 响应为 URL 编码的 Base64 密文，decodeURIComponent 后用同一 key AES-ECB 解密得到 JSON
 *   4. code=000000 成功；405 表示服务器认为本地时间偏差过大，响应携带 timestamp 用于校正
 *
 * 使用前配置 AUTH_TOKEN（必填）与 VIN（可留空自动获取第一辆车）。
 * Token 抓包方法：在雅迪 App 中进入任意 H5 车辆页面（如电池详情），
 * 抓包任意 tspapph5.yadeaiot.com.cn 请求，复制 Authorization 请求头。
 */

// ============================ 配置区 ============================

// Authorization 请求头（抓包获取，含或不含 "Bearer " 前缀均可）
const AUTH_TOKEN = "这里替换为你抓包得到的 Authorization 值";

// 车辆 VIN；留空则自动调用 queryBindingBike 取第一辆车
const VIN = "";

// 高德 Web 服务 Key（可选）；填写后显示停车位置文字与静态地图
const AMAP_API_KEY = "";

// 雅迪 H5 网关生产配置（取自 H5 前端 JS，公共常量）
const GATEWAY_APP_ID = "cfb00038ddac4c9ebc85821694bbd3fa";
const GATEWAY_SECRET = "RFC1J02e116b45a0";
const GATEWAY_BASE = "https://tspapph5.yadeaiot.com.cn/prod-wg";

// 时间偏差缓存键（405 校正，与 H5 前端 sessionStorage 行为一致）
const TS_OFFSET_KEY = "yadea.tsOffset";

// ============================ AES-128-ECB ============================
// Scriptable 无原生 AES，内嵌纯 JS 实现（已用 NIST 向量与 openssl 交叉验证）

const Sbox = [
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
const InvSbox = new Array(256);
for (let i = 0; i < 256; i++) InvSbox[Sbox[i]] = i;
const Rcon = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

/** GF(2^8) 乘 2 */
function xtime(a) {
  return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
}
/** GF(2^8) 乘法 */
function gfMul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    b >>= 1;
    a = xtime(a);
  }
  return p;
}
/** 128-bit 密钥扩展为 44 words */
function keyExpansion(keyBytes) {
  const w = new Array(44);
  for (let i = 0; i < 4; i++)
    w[i] = [keyBytes[4*i], keyBytes[4*i+1], keyBytes[4*i+2], keyBytes[4*i+3]];
  for (let i = 4; i < 44; i++) {
    let temp = w[i-1].slice();
    if (i % 4 === 0) {
      temp = [Sbox[temp[1]], Sbox[temp[2]], Sbox[temp[3]], Sbox[temp[0]]];
      temp[0] ^= Rcon[i/4 - 1];
    }
    w[i] = [w[i-4][0]^temp[0], w[i-4][1]^temp[1], w[i-4][2]^temp[2], w[i-4][3]^temp[3]];
  }
  return w;
}
function addRoundKey(state, w, round) {
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      state[r][c] ^= w[round*4 + c][r];
}
function subBytes(state, box) {
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      state[r][c] = box[state[r][c]];
}
function shiftRows(state) {
  let t;
  t = state[1][0]; state[1][0]=state[1][1]; state[1][1]=state[1][2]; state[1][2]=state[1][3]; state[1][3]=t;
  t = state[2][0]; state[2][0]=state[2][2]; state[2][2]=t; t=state[2][1]; state[2][1]=state[2][3]; state[2][3]=t;
  t = state[3][3]; state[3][3]=state[3][2]; state[3][2]=state[3][1]; state[3][1]=state[3][0]; state[3][0]=t;
}
function invShiftRows(state) {
  let t;
  t = state[1][3]; state[1][3]=state[1][2]; state[1][2]=state[1][1]; state[1][1]=state[1][0]; state[1][0]=t;
  t = state[2][0]; state[2][0]=state[2][2]; state[2][2]=t; t=state[2][1]; state[2][1]=state[2][3]; state[2][3]=t;
  t = state[3][0]; state[3][0]=state[3][1]; state[3][1]=state[3][2]; state[3][2]=state[3][3]; state[3][3]=t;
}
function mixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const a0=state[0][c], a1=state[1][c], a2=state[2][c], a3=state[3][c];
    state[0][c] = gfMul(a0,2)^gfMul(a1,3)^a2^a3;
    state[1][c] = a0^gfMul(a1,2)^gfMul(a2,3)^a3;
    state[2][c] = a0^a1^gfMul(a2,2)^gfMul(a3,3);
    state[3][c] = gfMul(a0,3)^a1^a2^gfMul(a3,2);
  }
}
function invMixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const a0=state[0][c], a1=state[1][c], a2=state[2][c], a3=state[3][c];
    state[0][c] = gfMul(a0,14)^gfMul(a1,11)^gfMul(a2,13)^gfMul(a3,9);
    state[1][c] = gfMul(a0,9)^gfMul(a1,14)^gfMul(a2,11)^gfMul(a3,13);
    state[2][c] = gfMul(a0,13)^gfMul(a1,9)^gfMul(a2,14)^gfMul(a3,11);
    state[3][c] = gfMul(a0,11)^gfMul(a1,13)^gfMul(a2,9)^gfMul(a3,14);
  }
}
function encryptBlock(w, block) {
  const state = [[],[],[],[]];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      state[r][c] = block[c*4 + r];
  addRoundKey(state, w, 0);
  for (let round = 1; round <= 9; round++) {
    subBytes(state, Sbox);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, w, round);
  }
  subBytes(state, Sbox);
  shiftRows(state);
  addRoundKey(state, w, 10);
  const out = new Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      out[c*4 + r] = state[r][c];
  return out;
}
function decryptBlock(w, block) {
  const state = [[],[],[],[]];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      state[r][c] = block[c*4 + r];
  addRoundKey(state, w, 10);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(state);
    subBytes(state, InvSbox);
    addRoundKey(state, w, round);
    invMixColumns(state);
  }
  invShiftRows(state);
  subBytes(state, InvSbox);
  addRoundKey(state, w, 0);
  const out = new Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      out[c*4 + r] = state[r][c];
  return out;
}
function pkcs7Pad(bytes) {
  const n = 16 - (bytes.length % 16);
  const out = bytes.slice();
  for (let i = 0; i < n; i++) out.push(n);
  return out;
}
function pkcs7Unpad(bytes) {
  const n = bytes[bytes.length - 1];
  if (n < 1 || n > 16) throw new Error("bad padding");
  return bytes.slice(0, bytes.length - n);
}

/** bytes -> base64：Scriptable 用 Data API，Node 测试环境回退 Buffer */
function bytesToBase64(bytes) {
  if (typeof Data !== "undefined" && Data.fromBytes) {
    return Data.fromBytes(bytes).toBase64String();
  }
  return Buffer.from(bytes).toString("base64");
}
/** base64 -> bytes */
function base64ToBytes(b64) {
  if (typeof Data !== "undefined" && Data.fromBase64String) {
    return Array.from(Data.fromBase64String(b64).getBytes());
  }
  return Array.from(Buffer.from(b64, "base64"));
}
/** UTF-8 字符串 -> 字节数组 */
function utf8Bytes(str) {
  const bytes = [];
  for (const ch of unescape(encodeURIComponent(str))) bytes.push(ch.charCodeAt(0));
  return bytes;
}

const AES128ECB = {
  /** key 短于 16 字节时右侧补 0x00（与雅迪网关 key 派生一致） */
  _keyBytes(keyStr) {
    const keyBytes = utf8Bytes(keyStr).slice(0, 16);
    while (keyBytes.length < 16) keyBytes.push(0);
    return keyBytes;
  },
  /** 加密 utf8 明文，返回 base64 */
  encryptToBase64(keyStr, plainStr) {
    const w = keyExpansion(this._keyBytes(keyStr));
    const padded = pkcs7Pad(utf8Bytes(plainStr));
    let out = "";
    for (let i = 0; i < padded.length; i += 16)
      out += String.fromCharCode(...encryptBlock(w, padded.slice(i, i + 16)));
    return bytesToBase64(utf8Bytes("").concat(Array.from(out).map(c => c.charCodeAt ? c.charCodeAt(0) : c)));
  },
  /** 解密 base64 密文（latin1 还原字节后去除 PKCS7，再 UTF-8 解码） */
  decryptFromBase64(keyStr, b64) {
    const w = keyExpansion(this._keyBytes(keyStr));
    const bytes = base64ToBytes(b64);
    if (bytes.length === 0 || bytes.length % 16 !== 0) throw new Error("bad ciphertext length");
    const raw = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const block = decryptBlock(w, bytes.slice(i, i + 16));
      for (const b of block) raw.push(b);
    }
    const unpadded = pkcs7Unpad(raw);
    let latin = "";
    for (const b of unpadded) latin += String.fromCharCode(b);
    return decodeURIComponent(escape(latin));
  }
};

// ============================ 网关请求层 ============================

/**
 * 读取时间偏差（ms）。405 时由服务器 timestamp 校正后写入缓存。
 * 无入参；返回数字。
 */
function getTimeOffset() {
  if (typeof FileManager === "undefined") return 0;
  try {
    const fm = FileManager.local();
    const path = fm.joinPath(fm.documentsDirectory(), "yadea.tsOffset");
    if (fm.fileExists(path)) return fm.readString(path) - 0 || 0;
  } catch (e) {}
  return 0;
}

/** 持久化时间偏差（ms） */
function setTimeOffset(offset) {
  try {
    const fm = FileManager.local();
    const path = fm.joinPath(fm.documentsDirectory(), "yadea.tsOffset");
    fm.writeString(path, String(offset));
  } catch (e) {}
}

/**
 * 构造网关签名头。入参为业务参数对象；返回 { gatewayTimestamp, gatewaySign } 头字典。
 * 明文固定为 `gatewayTimestamp=${ts}&json=${JSON.stringify(params)}`，与 H5 前端拦截器一致。
 */
function buildGatewayHeaders(params) {
  const ts = Date.now() + getTimeOffset();
  const plain = `gatewayTimestamp=${ts}&json=${JSON.stringify(params || {})}`;
  return {
    "gatewayTimestamp": String(ts),
    "gatewaySign": AES128ECB.encryptToBase64(GATEWAY_SECRET, plain)
  };
}

/**
 * 解密网关响应。入参为 loadString 得到的 URL 编码 Base64 密文；返回 JSON 对象。
 */
function decryptGatewayResponse(text) {
  const b64 = decodeURIComponent(text.trim());
  return JSON.parse(AES128ECB.decryptFromBase64(GATEWAY_SECRET, b64));
}

/**
 * 调用雅迪 H5 网关接口。入参为路径与业务参数对象；返回 data 字段或整个响应。
 * code=405 时按 H5 前端逻辑用服务器 timestamp 校正本地偏差并重试一次。
 */
async function yadeaRequest(path, params, retry = true) {
  const url = GATEWAY_BASE + path;
  const headers = buildGatewayHeaders(params);
  const req = new Request(url);
  req.method = "GET";
  req.headers = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "x-www-form-urlencoded;charset=utf-8",
    "Authorization": AUTH_TOKEN.indexOf("Bearer ") === 0 ? AUTH_TOKEN : "Bearer " + AUTH_TOKEN,
    "gatewayAppId": GATEWAY_APP_ID,
    "gatewayTimestamp": headers.gatewayTimestamp,
    "gatewaySign": headers.gatewaySign,
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 YadeaApp/8.8.9"
  };
  const text = await req.loadString();
  if (!text || !text.trim()) {
    throw new Error("网关响应为空");
  }
  const json = decryptGatewayResponse(text);

  if (json.code === "405" && retry && json.timestamp) {
    // 服务器时间 - 本地时间 = 校正偏移；与 H5 前端 sessionStorage 逻辑一致
    setTimeOffset(json.timestamp - Date.now());
    return yadeaRequest(path, params, false);
  }
  if (json.code !== "000000") {
    throw new Error(`网关错误 ${json.code}: ${json.msg || ""}`);
  }
  return json.data;
}

/** 查询绑定车辆列表，返回数组（含 vin、modelName 等） */
function getBindingBikes() {
  return yadeaRequest("/api/app/userBike/queryBindingBike", {});
}

/** 查询车辆实时状态（电量、续航、里程、位置、胎压等） */
function getVehRealStatus(vin) {
  return yadeaRequest("/api/app/bikeRealStatus/getVehRealStatus", { vin: vin });
}

/** 查询电池摘要（soc、soh、循环次数等） */
function getBattInfo(vin) {
  return yadeaRequest("/api/app/battSummary/queryBattInfo", { vin: vin, type: 0 });
}

// ============================ 工具函数 ============================

/**
 * 解析本次运行使用的 VIN。入参无；返回字符串。
 * 优先级：脚本内 VIN 配置 > Widget 参数 > 在线车辆列表第一辆。
 */
async function resolveVin() {
  if (VIN) return VIN;
  const param = (args.widgetParameter || "").trim();
  if (/^\d+$/.test(param)) return param;
  const bikes = await getBindingBikes();
  if (!bikes || !bikes.length) throw new Error("未找到绑定车辆");
  return bikes[0].vin;
}

/** 时间差人性化：不足 1 分钟显示秒，不足 1 小时显示分钟，其余显示小时 */
function humanizeAge(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  if (sec < 86400) return Math.floor(sec / 3600) + "h";
  return Math.floor(sec / 86400) + "d";
}

/** WGS84 判断是否在中国境外（境外不做 GCJ02 纠偏） */
function isLocationOutOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  const pi = 3.14159265358979324;
  let lat = -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
  lat += (20.0*Math.sin(6.0*x*pi) + 20.0*Math.sin(2.0*x*pi)) * 2.0 / 3.0;
  lat += (20.0*Math.sin(y*pi) + 40.0*Math.sin(y/3.0*pi)) * 2.0 / 3.0;
  lat += (160.0*Math.sin(y/12.0*pi) + 320*Math.sin(y*pi/30.0)) * 2.0 / 3.0;
  return lat;
}
function transformLon(x, y) {
  const pi = 3.14159265358979324;
  let lon = 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
  lon += (20.0*Math.sin(6.0*x*pi) + 20.0*Math.sin(2.0*x*pi)) * 2.0 / 3.0;
  lon += (20.0*Math.sin(x*pi) + 40.0*Math.sin(x/3.0*pi)) * 2.0 / 3.0;
  lon += (150.0*Math.sin(x/12.0*pi) + 300.0*Math.sin(x/30.0*pi)) * 2.0 / 3.0;
  return lon;
}

/** WGS84 -> GCJ02 火星坐标（雅迪 TSP 坐标按 WGS84 处理，如定位偏差可关闭） */
function wgs2gcj(lat, lng) {
  if (isLocationOutOfChina(lat, lng)) return { lat: lat, lng: lng };
  const a = 6378245.0, ee = 0.00669342162296594323, pi = 3.14159265358979324;
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLon = transformLon(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * pi;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * pi);
  dLon = (dLon * 180.0) / (a / sqrtMagic * Math.cos(radLat) * pi);
  return { lat: lat + dLat, lng: lng + dLon };
}

// ============================ 缓存层 ============================

/** 缓存目录/文件路径。入参为文件名；返回绝对路径 */
function cachePath(fm, name) {
  const dir = fm.joinPath(fm.documentsDirectory(), "yadea");
  if (!fm.isDirectory(dir)) fm.createDirectory(dir, true);
  return fm.joinPath(dir, name);
}

/** 读取 JSON 缓存，损坏返回 null */
function readCache(fm, name) {
  try {
    const path = cachePath(fm, name);
    if (!fm.fileExists(path)) return null;
    return JSON.parse(fm.readString(path));
  } catch (e) {
    return null;
  }
}

/** 写 JSON 缓存（静默失败） */
function writeCache(fm, name, value) {
  try {
    fm.writeString(cachePath(fm, name), JSON.stringify(value));
  } catch (e) {}
}

/**
 * 加载车辆数据：优先在线请求，失败回退本地缓存。
 * 入参为 FileManager 与 vin；返回 { status, data, batt } 或抛出异常。
 */
async function loadVehicleData(fm, vin) {
  const cacheFile = "car_data_" + vin + ".json";
  try {
    const status = await getVehRealStatus(vin);
    const batt = await getBattInfo(vin);
    writeCache(fm, cacheFile, { status: status, batt: batt, fetchedAt: Date.now() });
    return { status: status, batt: batt, fetchedAt: Date.now() };
  } catch (e) {
    console.log("在线请求失败，尝试缓存");
    const cached = readCache(fm, cacheFile);
    if (!cached || !cached.status) throw e;
    return cached;
  }
}

// ============================ 渲染层 ============================

/**
 * 归纳车辆显示状态。入参为 status 数据；返回 { key, label, symbol, color }。
 * chgStatus/rideStatus 的非零取值语义按 TSP 常见定义推断，未知时回退在线/离线。
 */
function summarizeState(status) {
  if (status.onlineState === false) {
    return { key: "offline", label: "离线", symbol: "wifi.exclamationmark", color: Color.red() };
  }
  if (status.chgStatus === 1) {
    return { key: "charging", label: "充电中", symbol: "bolt.fill", color: Color.green() };
  }
  if (status.rideStatus === 1) {
    return { key: "riding", label: "骑行中", symbol: "bicycle", color: Color.green() };
  }
  return { key: "idle", label: "在线", symbol: "parkingsign.circle", color: Color.white() };
}

/** 绘制电量图形（外框 + 填充）。入参为电量百分比与是否充电；返回 Image */
function drawBattery(percent, charging) {
  const dc = new DrawContext();
  dc.opaque = false;
  dc.size = new Size(50, 16);
  const path = new Path();
  path.addRoundedRect(new Rect(0, 0, 42, 14), 2, 2);
  path.addRoundedRect(new Rect(43, 3, 3, 8), 1, 1);
  dc.addPath(path);
  dc.setFillColor(charging ? Color.green() : Color.white());
  dc.fillPath();

  const fillW = Math.max(1, Math.round(percent / 100 * 40));
  const inner = new DrawContext();
  inner.opaque = false;
  inner.size = new Size(42, 12);
  const ip = new Path();
  ip.addRoundedRect(new Rect(0, 0, fillW, 12), 1, 1);
  inner.addPath(ip);
  inner.setFillColor(charging ? Color.yellow() : Color.white());
  inner.fillPath();
  dc.drawImageAtPoint(inner.getImage(), new Point(1, 1));
  return dc.getImage();
}

/** 依据角度计算圆环上点位（正上方为 0 度）。入参半径、角度、圆心；返回 [x, y] */
function ringPoint(length, angle, center) {
  const rad = angle * Math.PI / 180;
  const x = length * Math.sin(rad);
  const y = length * Math.cos(rad);
  return [center + x, center - y];
}

/**
 * 渲染锁屏圆形 Widget：电量环 + 数字。
 * 入参为 vehicle 数据；无返回值（内部完成 setWidget）。
 */
function renderAccessory(data) {
  const soc = data.status.totalSoc != null ? data.status.totalSoc : (data.status.soc1 || 0);
  const widget = new ListWidget();
  widget.setPadding(0, 0, 0, 0);

  // 逐点绘制电量进度环（Scriptable strokeEllipse 不支持角度参数）
  const dc = new DrawContext();
  dc.size = new Size(100, 100);
  dc.opaque = false;

  // 底环
  const dotW = 8;
  dc.setFillColor(Color.gray());
  for (let angle = 0; angle < 360; angle += 2) {
    const loc = ringPoint(40, angle, 50);
    dc.fillEllipse(new Rect(loc[0] - 1, loc[1] - 1, 2, 2));
  }
  // 电量环：按百分比逐度填充，颜色随电量与充电状态变化
  dc.setFillColor(soc <= 20 ? Color.red() : (data.status.chgStatus === 1 ? Color.green() : Color.white()));
  for (let angle = 0; angle <= 360 / 100 * soc; angle += 1) {
    const loc = ringPoint(40, angle, 50);
    dc.fillEllipse(new Rect(loc[0] - dotW/2, loc[1] - dotW/2, dotW, dotW));
  }

  dc.setTextColor(Color.white());
  dc.setFont(Font.boldMonospacedSystemFont(30));
  dc.setTextAlignedCenter();
  dc.drawText(String(soc), new Rect(0, 34, 100, 40));
  dc.setFont(Font.mediumSystemFont(13));
  dc.drawText("%", new Rect(0, 64, 100, 20));

  widget.addImage(dc.getImage());
  Script.setWidget(widget);
  widget.presentSmall();
}

/**
 * 渲染中号 Widget。入参为 vehicle 数据与车型名；无返回值。
 */
function renderMedium(data, modelName) {
  const status = data.status;
  const batt = data.batt || {};
  const soc = status.totalSoc != null ? status.totalSoc : (status.soc1 || 0);
  const charging = status.chgStatus === 1;
  const state = summarizeState(status);

  const widget = new ListWidget();
  widget.backgroundColor = new Color("#1c1c1e");
  widget.setPadding(12, 15, 12, 15);
  // 刷新策略：充电/骑行 30 秒，其余 60 秒
  widget.refreshAfterDate = new Date(Date.now() + (charging || status.rideStatus === 1 ? 30 : 60) * 1000);

  // 行1：车型名 + 状态
  const line1 = widget.addStack();
  line1.centerAlignContent();
  const name = line1.addText(modelName || ("雅迪 " + status.vin.slice(-6)));
  name.font = Font.mediumSystemFont(15);
  name.lineLimit = 1;
  line1.addSpacer(6);
  const sym = line1.addImage(SFSymbol.named(state.symbol).image);
  sym.tintColor = state.color;
  sym.imageSize = new Size(16, 16);
  const label = line1.addText(" " + state.label);
  label.font = Font.mediumSystemFont(12);
  label.textColor = state.color;

  widget.addSpacer(6);

  // 行2：电池图形 + 电量 + 剩余续航
  const line2 = widget.addStack();
  line2.centerAlignContent();
  line2.addImage(drawBattery(soc, charging)).imageSize = new Size(52, 17);
  line2.addSpacer(6);
  const socText = line2.addText(soc + "%");
  socText.font = Font.boldSystemFont(22);
  socText.textColor = charging ? Color.green() : Color.white();
  line2.addSpacer(6);
  const range = line2.addText("⚡ " + (status.remMileage != null ? status.remMileage : "-") + " km");
  range.font = Font.mediumSystemFont(14);
  range.textColor = Color.orange();

  // 行3：核心数据行
  widget.addSpacer(6);
  const line3 = widget.addStack();
  const items = [];
  if (status.totalMileage != null) items.push("总里程 " + status.totalMileage + "km");
  if (batt.soh != null) items.push("SOH " + batt.soh + "%");
  if (status.mosTemp1 != null) items.push("电池 " + status.mosTemp1 + "℃");
  if (status.volt != null) items.push(status.volt + "V");
  const info = line3.addText(items.join(" · "));
  info.font = Font.mediumSystemFont(11);
  info.textColor = Color.gray();
  info.lineLimit = 1;

  // 行4：胎压异常提示（有告警时才显示，避免误导）
  if ((status.leftFrontPressureWarning || 0) > 0 || (status.leftRearPressureWarning || 0) > 0) {
    widget.addSpacer(4);
    const warn = widget.addText("⚠️ 胎压异常");
    warn.font = Font.mediumSystemFont(11);
    warn.textColor = Color.yellow();
  }

  // 行5：数据时间 + 位置
  widget.addSpacer(6);
  const line5 = widget.addStack();
  const age = humanizeAge(Date.now() - (data.fetchedAt || status.collectTime || Date.now()));
  const locText = line5.addText(age + "前 · " + (data.geofence || "雅迪智造"));
  locText.font = Font.mediumSystemFont(11);
  locText.textColor = Color.gray();
  locText.lineLimit = 1;
  if (data.latitude != null) {
    widget.url = `http://maps.apple.com/?ll=${data.latitude},${data.longitude}&q=` + encodeURI(modelName || "车辆位置");
  }

  Script.setWidget(widget);
  widget.presentMedium();
}

/**
 * 请求位置描述（高德逆地理，失败返回 null）。入参为 GCJ02 坐标。
 */
async function reverseGeocode(lat, lng) {
  if (!AMAP_API_KEY) return null;
  try {
    const url = `https://restapi.amap.com/v3/geocode/regeo?key=${AMAP_API_KEY}&location=${lng},${lat}&extensions=base`;
    const req = new Request(url);
    const json = await req.loadJSON();
    const comp = json && json.regeocode && json.regeocode.addressComponent;
    if (!comp) return null;
    return [comp.district, comp.township].filter(Boolean).join(" ") || null;
  } catch (e) {
    return null;
  }
}

// ============================ 主流程 ============================

/**
 * 唯一运行入口：App 运行时输出 JSON 调试信息，Widget 上下文渲染组件。
 */
async function main() {
  const fm = FileManager.local();
  const vin = await resolveVin();
  const data = await loadVehicleData(fm, vin);

  // 位置处理：缓存位置名，坐标变化时刷新
  const locCache = readCache(fm, "car_geo_" + vin + ".json");
  const lat = data.status.lat, lng = data.status.lon;
  if (lat != null && lng != null) {
    data.latitude = lat;
    data.longitude = lng;
    const moved = !locCache || locCache.lat !== lat || locCache.lng !== lng;
    if (moved) {
      const gcj = wgs2gcj(lat, lng);
      const geofence = await reverseGeocode(gcj.lat, gcj.lng);
      writeCache(fm, "car_geo_" + vin + ".json", {
        lat: lat, lng: lng, geofence: geofence || ""
      });
      data.geofence = geofence || "";
    } else {
      data.geofence = locCache.geofence || "";
    }
  }

  // 车型名缓存（queryBindingBike 失败不影响主流程）
  let modelName = "";
  const nameCache = readCache(fm, "car_name_" + vin + ".json");
  if (nameCache && nameCache.modelName) {
    modelName = nameCache.modelName;
  } else {
    try {
      const bikes = await getBindingBikes();
      const mine = bikes.find(b => b.vin === vin) || bikes[0];
      if (mine) {
        modelName = mine.modelName || "";
        writeCache(fm, "car_name_" + vin + ".json", { modelName: modelName });
      }
    } catch (e) {}
  }

  // 刷新策略已内置在 renderMedium 中（充电/骑行 30 秒，其余 60 秒）

  if (config.runsInWidget || config.runsInAccessoryWidget) {
    if (config.widgetFamily === "accessoryCircular") {
      renderAccessory(data);
    } else {
      renderMedium(data, modelName);
    }
    // present 之后补充刷新时间
    return;
  }

  // App 内运行：打印完整数据便于调试
  console.log(JSON.stringify(data, null, 2));
  const alert = new Alert();
  alert.title = modelName || "雅迪电动车";
  alert.message =
    `电量 ${data.status.totalSoc}% · 续航 ${data.status.remMileage}km\n` +
    `总里程 ${data.status.totalMileage}km · SOH ${data.batt ? data.batt.soh : "-"}%\n` +
    `状态 ${summarizeState(data.status).label} · VIN ${data.status.vin}`;
  alert.addAction("好");
  await alert.presentAlert();
}

await main()
  .catch(err => {
    console.error("雅迪状态获取失败: " + err.message);
    if (config.runsInWidget || config.runsInAccessoryWidget) {
      const widget = new ListWidget();
      const text = widget.addText("雅迪\n" + (err.message || "获取失败"));
      text.font = Font.mediumSystemFont(12);
      text.textColor = Color.red();
      Script.setWidget(widget);
      if (config.widgetFamily === "accessoryCircular") widget.presentAccessoryCircular();
      else widget.presentMedium();
    }
  })
  .finally(() => {
    Script.complete();
  });
