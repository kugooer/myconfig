// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: battery-half;

/**
 * 雅迪电动车状态 Widget（Scriptable）
 * 布局与处理规则严格参考 kugooer/teslamate-widget 的 Telsa Car.js。
 *
 * 数据来源：雅迪智造 App 内嵌 H5（tspapph5.yadeaiot.com.cn/prod-wg）网关。
 * 网关协议（已从 H5 前端 JS chunk-common 逆向确认）：
 *   1. gatewaySign = Base64(AES-128-ECB-PKCS7(`gatewayTimestamp=${ms}&json=${JSON.stringify(params)}`, key))
 *      key 为 H5 prod secret（16 字节，短于 16 字节右侧补 0x00）
 *   2. 请求头携带 gatewayAppId / gatewaySign / gatewayTimestamp，无 query、无 body
 *   3. 响应为 URL 编码的 Base64 密文，decodeURIComponent 后用同一 key AES-ECB 解密得到 JSON
 *   4. code=000000 成功；405 表示服务器认为本地时间偏差过大，响应携带 timestamp 用于校正
 *
 * 配置唯一来源是 Scriptable iCloud documents 下的 yadea/config.v1.json，
 * 通过 App 内表单录入（Token 安全文本框 / VIN / 高德 Key），仓库脚本不保存任何凭据。
 * 运行上下文：
 *   - config.runsInApp：配置门禁 + 菜单（查看当前数据 / 管理配置）
 *   - config.runsInAccessoryWidget：锁屏圆形电量 Widget
 *   - 其他 Widget 场景：中号桌面 Widget（左信息 + 右高德静态地图）
 */

const MEDIUM_WIDGET_HEIGHT = 176;
const MAP_PANEL_SIZE = 176;

// 雅迪 H5 网关生产配置（取自公开 H5 前端 JS，公共常量，非个人凭据）
const GATEWAY_APP_ID = "cfb00038ddac4c9ebc85821694bbd3fa";
const GATEWAY_SECRET = "RFC1J02e116b45a0";
const GATEWAY_BASE = "https://tspapph5.yadeaiot.com.cn/prod-wg";

const CONFIG_SCHEMA_VERSION = 1;

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
    const out = [];
    for (let i = 0; i < padded.length; i += 16) {
      const block = encryptBlock(w, padded.slice(i, i + 16));
      for (const b of block) out.push(b);
    }
    return bytesToBase64(out);
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

// ============================ 配置层（iCloud 状态机 + 事务保存） ============================

/** 配置规范化：去除首尾空白。入参为原始字符串；返回 string */
function normalizeConfigValue(value) {
  return String(value == null ? "" : value).trim();
}

/**
 * 验证业务配置三字段。入参为候选对象；成功返回 { ok: true, value }，失败返回 { ok: false }。
 * Token 必填；VIN 与高德 Key 可选。校验失败不回显具体输入，避免泄露。
 */
function validateBusinessConfig(candidate) {
  if (!candidate || typeof candidate !== "object") return { ok: false };
  const authToken = normalizeConfigValue(candidate.authToken);
  if (!authToken) return { ok: false };
  return {
    ok: true,
    value: {
      authToken: authToken,
      vin: normalizeConfigValue(candidate.vin),
      amapApiKey: normalizeConfigValue(candidate.amapApiKey)
    }
  };
}

/**
 * 验证 iCloud schema v1 envelope。
 * 入参为解析后的 JSON 对象；有效返回 { ok: true, value }（仅白名单业务字段），无效返回 { ok: false }。
 */
function validateICloudConfigEnvelope(json) {
  if (!json || typeof json !== "object") return { ok: false };
  if (json.schemaVersion !== CONFIG_SCHEMA_VERSION) return { ok: false };
  if (typeof json.updatedAt !== "string" || isNaN(new Date(json.updatedAt).getTime())) return { ok: false };
  const business = validateBusinessConfig({ authToken: json.authToken, vin: json.vin, amapApiKey: json.amapApiKey });
  if (!business.ok) return { ok: false };
  return { ok: true, value: business.value };
}

/** 逐字段比较两个已验证 envelope（业务字段比较，与 schemaVersion/updatedAt 无关） */
function businessConfigsEqual(left, right) {
  return left.authToken === right.authToken &&
    left.vin === right.vin &&
    left.amapApiKey === right.amapApiKey;
}

/**
 * 创建一次 iCloud 配置操作使用的固定路径集合。
 * 读取、保存事务必须共享同一 FileManager.iCloud() 实例与目录。
 */
function createICloudConfigStorage() {
  const fm = FileManager.iCloud();
  const directoryPath = fm.joinPath(fm.documentsDirectory(), "yadea");
  return {
    fm: fm,
    directoryPath: directoryPath,
    configPath: fm.joinPath(directoryPath, "config.v1.json"),
    pendingPath: fm.joinPath(directoryPath, "config.v1.pending.json"),
    backupPath: fm.joinPath(directoryPath, "config.v1.backup.json")
  };
}

/**
 * 读取一个 iCloud 配置文件并区分内容无效与存储暂不可用。
 * 入参为 iCloud manager 与文件路径；返回 { status: "ready"|"invalid"|"unavailable", value? }。
 * 日志只记录固定分类，异常对象可能含路径或正文。
 */
function readAndValidateICloudConfigFile(fm, filePath) {
  let serializedConfig;
  try {
    serializedConfig = fm.readString(filePath);
  } catch (error) {
    console.log("运行配置读取暂时不可用");
    return { status: "unavailable" };
  }
  if (typeof serializedConfig !== "string") {
    console.log("运行配置读取暂时不可用");
    return { status: "unavailable" };
  }
  try {
    const parsed = JSON.parse(serializedConfig);
    const validated = validateICloudConfigEnvelope(parsed);
    if (!validated.ok) {
      console.log("运行配置内容无效");
      return { status: "invalid" };
    }
    return { status: "ready", value: validated.value };
  } catch (error) {
    console.log("运行配置内容无效");
    return { status: "invalid" };
  }
}

/**
 * 从 iCloud 固定正式文件加载运行配置状态。
 * 入参为 runsInApp；返回 { status: "ready"|"missing"|"unavailable"|"invalid", value? }。
 * Widget 只读已下载副本（isFileDownloaded），不触发下载；App 先 download 再读取。
 * 非 ready 状态下 Widget 不发起任何网络请求或缓存初始化。
 */
function loadRuntimeConfig(runsInApp) {
  let storage;
  try {
    storage = createICloudConfigStorage();
  } catch (error) {
    console.log("iCloud 存储暂不可用");
    return { status: "unavailable" };
  }
  const exists = storage.fm.fileExists(storage.configPath);
  if (runsInApp) {
    if (!exists) {
      return { status: "missing" };
    }
    try {
      storage.fm.downloadFileFromiCloud(storage.configPath);
    } catch (error) {
      console.log("iCloud 配置下载暂不可用");
      return { status: "unavailable" };
    }
    return readAndValidateICloudConfigFile(storage.fm, storage.configPath);
  }
  // Widget：未下载立即降级 unavailable，避免占用执行预算
  if (!exists) {
    return { status: "missing" };
  }
  let downloaded = true;
  try {
    downloaded = storage.fm.isFileDownloaded(storage.configPath);
  } catch (error) {
    console.log("iCloud 下载状态检查暂不可用");
    downloaded = true; // 桥接异常时按本地已有内容尝试读取
  }
  if (!downloaded) {
    return { status: "unavailable" };
  }
  return readAndValidateICloudConfigFile(storage.fm, storage.configPath);
}

/** 尽力删除保存事务工件且不传播底层错误。入参为 manager 与路径；无返回值 */
function tryRemoveConfigArtifact(fm, filePath) {
  try {
    if (fm.fileExists(filePath)) {
      fm.remove(filePath);
    }
  } catch (error) {
    console.log("运行配置工件清理失败");
  }
}

/**
 * 事务性保存运行配置到 iCloud。
 * 入参为已验证业务配置；成功返回 { ok: true, value }，失败返回 { ok: false }。
 * 流程：清旧 pending -> 写 pending -> 读回逐字段校验 -> 正式存在则
 * move(正式->backup)、move(pending->正式)、复读校验、删 backup；失败恢复 backup。
 * 正式不存在时直接 move(pending->正式)。Scriptable 无 iCloud 锁，不支持并发编辑。
 */
function saveRuntimeConfig(validatedConfig) {
  let storage;
  try {
    storage = createICloudConfigStorage();
  } catch (error) {
    console.log("iCloud 存储暂不可用");
    return { ok: false };
  }
  const fm = storage.fm;
  try {
    if (!fm.isDirectory(storage.directoryPath)) {
      fm.createDirectory(storage.directoryPath, true);
    }
  } catch (error) {
    console.log("iCloud 配置目录创建失败");
    return { ok: false };
  }

  // 收敛上次中断留下的 pending
  tryRemoveConfigArtifact(fm, storage.pendingPath);

  const envelope = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    authToken: validatedConfig.authToken,
    vin: validatedConfig.vin,
    amapApiKey: validatedConfig.amapApiKey
  };
  try {
    fm.writeString(storage.pendingPath, JSON.stringify(envelope));
  } catch (error) {
    console.log("iCloud 配置写入失败");
    tryRemoveConfigArtifact(fm, storage.pendingPath);
    return { ok: false };
  }

  // 写后读校验 pending
  const pendingCheck = readAndValidateICloudConfigFile(fm, storage.pendingPath);
  if (pendingCheck.status !== "ready" || !businessConfigsEqual(pendingCheck.value, validatedConfig)) {
    console.log("pending 配置校验失败");
    tryRemoveConfigArtifact(fm, storage.pendingPath);
    return { ok: false };
  }

  const hadOfficial = fm.fileExists(storage.configPath);
  if (hadOfficial) {
    try {
      fm.move(storage.configPath, storage.backupPath);
      fm.move(storage.pendingPath, storage.configPath);
    } catch (error) {
      console.log("iCloud 配置替换失败");
      try {
        if (!fm.fileExists(storage.configPath) && fm.fileExists(storage.backupPath)) {
          fm.move(storage.backupPath, storage.configPath);
        }
      } catch (restoreError) {
        console.log("iCloud 配置恢复失败");
      }
      tryRemoveConfigArtifact(fm, storage.pendingPath);
      return { ok: false };
    }
  } else {
    try {
      fm.move(storage.pendingPath, storage.configPath);
    } catch (error) {
      console.log("iCloud 配置安装失败");
      tryRemoveConfigArtifact(fm, storage.pendingPath);
      return { ok: false };
    }
  }

  // 复读正式文件并逐字段校验
  const officialCheck = readAndValidateICloudConfigFile(fm, storage.configPath);
  const success = officialCheck.status === "ready" && businessConfigsEqual(officialCheck.value, validatedConfig);
  if (success) {
    tryRemoveConfigArtifact(fm, storage.backupPath);
    return { ok: true, value: validatedConfig };
  }
  console.log("正式配置复读校验失败");
  if (hadOfficial) {
    try {
      if (fm.fileExists(storage.backupPath)) {
        fm.move(storage.backupPath, storage.configPath);
      }
    } catch (error) {
      console.log("iCloud 配置恢复失败");
    }
  }
  tryRemoveConfigArtifact(fm, storage.pendingPath);
  return { ok: false };
}

/** 弹出固定消息框。入参为标题与正文；无返回值 */
async function presentMessage(title, message) {
  const alert = new Alert();
  alert.title = title;
  alert.message = message;
  alert.addAction("好");
  await alert.presentAlert();
}

/**
 * 配置表单（仅 App 内运行）：录入抓包 Token、VIN 与高德 Key。
 * 入参为当前配置（用于预填，可为 null）；保存成功返回标准化配置，取消返回 null。
 * Token 使用安全文本框；文本框只能用于 alert，不能用于 action sheet。
 */
async function presentConfigForm(initialConfig) {
  let formValues = {
    authToken: initialConfig ? initialConfig.authToken : "",
    vin: initialConfig ? initialConfig.vin : "",
    amapApiKey: initialConfig ? initialConfig.amapApiKey : ""
  };
  while (true) {
    const form = new Alert();
    form.title = "雅迪组件配置";
    form.message = "配置将保存在 iCloud Drive 中";
    form.addSecureTextField("Authorization Token（抓包获取）", formValues.authToken);
    form.addTextField("VIN（留空自动获取）", formValues.vin);
    form.addTextField("高德 API Key（可选，右侧地图）", formValues.amapApiKey);
    form.addAction("保存");
    form.addCancelAction("取消");

    const actionIndex = await form.presentAlert();
    // 取消动作统一返回 -1；非保存下标不读取表单内容
    if (actionIndex !== 0) {
      return null;
    }

    const candidate = {
      authToken: form.textFieldValue(0),
      vin: form.textFieldValue(1),
      amapApiKey: form.textFieldValue(2)
    };
    const validationResult = validateBusinessConfig(candidate);
    if (!validationResult.ok) {
      formValues = candidate;
      await presentMessage("配置无效", "Authorization Token 不能为空");
      continue;
    }

    const saveResult = saveRuntimeConfig(validationResult.value);
    if (!saveResult.ok) {
      await presentMessage("保存失败", "无法写入 iCloud，请稍后重试");
      continue;
    }
    await presentMessage("已保存", "已保存到 iCloud Drive，将由系统同步到其他设备");
    return saveResult.value;
  }
}

// ============================ 网关请求层 ============================

/** 读取时间偏差（ms）。405 时由服务器 timestamp 校正后写入本地缓存 */
function getTimeOffset() {
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
 * 调用雅迪 H5 网关接口。入参为路径、业务参数对象与运行配置；返回 data 字段。
 * code=405 时按 H5 前端逻辑用服务器 timestamp 校正本地偏差并重试一次。
 */
async function yadeaRequest(runtimeConfig, path, params, retry = true) {
  const url = GATEWAY_BASE + path;
  const headers = buildGatewayHeaders(params);
  const req = new Request(url);
  req.method = "GET";
  req.headers = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "x-www-form-urlencoded;charset=utf-8",
    "Authorization": runtimeConfig.authToken.indexOf("Bearer ") === 0
      ? runtimeConfig.authToken
      : "Bearer " + runtimeConfig.authToken,
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
    setTimeOffset(json.timestamp - Date.now());
    return yadeaRequest(runtimeConfig, path, params, false);
  }
  if (json.code !== "000000") {
    throw new Error("网关错误 " + json.code);
  }
  return json.data;
}

/** 查询绑定车辆列表（含 vin、bikeNickName、modelName 等） */
function getBindingBikes(runtimeConfig) {
  return yadeaRequest(runtimeConfig, "/api/app/userBike/queryBindingBike", {});
}

/** 查询车辆实时状态（电量、续航、里程、位置、胎压等） */
function getVehRealStatus(runtimeConfig, vin) {
  return yadeaRequest(runtimeConfig, "/api/app/bikeRealStatus/getVehRealStatus", { vin: vin });
}

/** 查询电池摘要（soc、soh、循环次数等） */
function getBattInfo(runtimeConfig, vin) {
  return yadeaRequest(runtimeConfig, "/api/app/battSummary/queryBattInfo", { vin: vin, type: 0 });
}

// ============================ 缓存与车辆上下文 ============================

/**
 * 创建本地运行时上下文：缓存根目录与待填充的 widget。
 * 配置门禁通过后才调用；返回 { fm, fileRoot, widget }。
 */
function createRuntimeContext() {
  const fm = FileManager.local();
  const fileRoot = fm.joinPath(fm.documentsDirectory(), "yadea");
  if (!fm.isDirectory(fileRoot)) {
    fm.createDirectory(fileRoot, true);
  }
  return { fm: fm, fileRoot: fileRoot, widget: new ListWidget() };
}

/**
 * 校验雅迪网关车辆状态响应的顶层契约。
 * 入参为解析后的对象；结构完整返回 true，错误对象或缺失字段返回 false。
 */
function isValidVehicleResponse(data) {
  return !!(data && data.data && typeof data.data.vin === "string" &&
    data.data.totalSoc != null);
}

/**
 * 加载车辆状态：请求失败或响应无效时回退本地缓存；无缓存抛固定脱敏错误。
 * 入参为 runtimeConfig、fm 与缓存文件路径；返回 { status, batt, fetchedAt }。
 * 异常对象可能包含私有 URL，日志只保留固定分类。
 */
async function loadVehicleDataWithCache(runtimeConfig, fm, file) {
  try {
    const status = await getVehRealStatus(runtimeConfig, runtimeConfig.vin);
    let batt = null;
    try {
      batt = await getBattInfo(runtimeConfig, runtimeConfig.vin);
    } catch (e) {
      console.log("电池摘要请求失败，忽略");
    }
    const combined = { status: status, batt: batt, fetchedAt: Date.now() };
    fm.writeString(file, JSON.stringify(combined));
    return combined;
  } catch (error) {
    console.log("车辆状态请求失败，尝试读取缓存");
  }
  if (!fm.fileExists(file)) {
    throw new Error("车辆状态加载失败");
  }
  let cached;
  try {
    cached = JSON.parse(fm.readString(file));
  } catch (error) {
    console.log("车辆缓存读取失败");
    throw new Error("车辆状态加载失败");
  }
  if (!isValidVehicleResponse(cached.status)) {
    console.log("车辆缓存内容无效");
    throw new Error("车辆状态加载失败");
  }
  return cached;
}

/** 判断车辆坐标相对上次缓存是否变化。入参为当前与上一坐标对象；返回布尔值 */
function hasCarMoved(cur, prev) {
  return !prev || cur.lat !== prev.lat || cur.lng !== prev.lng;
}

/** 时间差人性化：不足 1 分钟显示秒，不足 1 小时显示分钟，其余显示小时 */
function humanizeAge(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  if (sec < 86400) return Math.floor(sec / 3600) + "h";
  return Math.floor(sec / 86400) + "d";
}

// ============================ 坐标转换（WGS84 -> GCJ02） ============================

/** 判断是否在中国境外（境外不做 GCJ02 纠偏） */
function isLocationOutOfChina(latitude, longitude) {
  if (longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271)
    return true;
  return false;
}

function transformLatWithXY(x, y) {
  const pi = 3.14159265358979324;
  let lat = -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
  lat += (20.0*Math.sin(6.0*x*pi) + 20.0*Math.sin(2.0*x*pi)) * 2.0 / 3.0;
  lat += (20.0*Math.sin(y*pi) + 40.0*Math.sin(y/3.0*pi)) * 2.0 / 3.0;
  lat += (160.0*Math.sin(y/12.0*pi) + 320*Math.sin(y*pi/30.0)) * 2.0 / 3.0;
  return lat;
}
function transformLonWithXY(x, y) {
  const pi = 3.14159265358979324;
  let lon = 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
  lon += (20.0*Math.sin(6.0*x*pi) + 20.0*Math.sin(2.0*x*pi)) * 2.0 / 3.0;
  lon += (20.0*Math.sin(x*pi) + 40.0*Math.sin(x/3.0*pi)) * 2.0 / 3.0;
  lon += (150.0*Math.sin(x/12.0*pi) + 300.0*Math.sin(x/30.0*pi)) * 2.0 / 3.0;
  return lon;
}

/** WGS84 -> GCJ02 火星坐标（雅迪 TSP 坐标按 WGS84 处理） */
function wgs2gcj(latitude, longitude) {
  const ee = 0.00669342162296594323;
  const a = 6378245.0;
  const pi = 3.14159265358979324;
  if (isLocationOutOfChina(latitude, longitude)) {
    return { latitude: latitude, longitude: longitude };
  }
  let adjustLat = transformLatWithXY(longitude - 105.0, latitude - 35.0);
  let adjustLon = transformLonWithXY(longitude - 105.0, latitude - 35.0);
  const radLat = latitude / 180.0 * pi;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  adjustLat = (adjustLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * pi);
  adjustLon = (adjustLon * 180.0) / (a / sqrtMagic * Math.cos(radLat) * pi);
  return { latitude: latitude + adjustLat, longitude: longitude + adjustLon };
}

/**
 * 加载车辆位置描述与高德静态地图，并维护按 VIN 隔离的缓存。
 * 地址文字优先使用 iOS Location.reverseGeocode；高德 Key 仅用于静态地图。
 * 定位或地图请求失败时沿用已有缓存/占位策略。返回 { geofence, latitude, longitude, lat, lng, image }。
 */
async function getCarGeo(runtimeContext, runtimeConfig, vin, status, prevCoord, lat, lng) {
  const fm = runtimeContext.fm;
  const geo = wgs2gcj(lat, lng);
  const moved = hasCarMoved({ lat: lat, lng: lng }, prevCoord);

  // 地理文字缓存：车辆未移动时直接复用
  let json = null;
  const geoFile = fm.joinPath(runtimeContext.fileRoot, `car_geo_${vin}.json`);
  if (fm.fileExists(geoFile)) {
    try {
      json = JSON.parse(fm.readString(geoFile));
    } catch (e) {
      json = null;
    }
  }
  if (json == null || moved) {
    try {
      const location = await Location.reverseGeocode(geo.latitude, geo.longitude, "zh-CN");
      json = location;
      fm.writeString(geoFile, JSON.stringify(location));
    } catch (e) {
      console.log("地理编码失败");
      if (json == null) {
        json = [{ name: "未知位置" }];
      }
    }
  }
  // iOS reverseGeocode 返回数组；兼容对象形态的高德缓存
  let geofence = "未知位置";
  if (Array.isArray(json)) {
    geofence = (json[0] && (json[0].name || json[0].thoroughfare)) || geofence;
  } else if (json && json.regeocode) {
    geofence = (json.regeocode.addressComponent && json.regeocode.addressComponent.township) || geofence;
  }

  // 静态地图缓存：车辆未移动且已有图片时直接复用
  let image = null;
  const mapFile = fm.joinPath(runtimeContext.fileRoot, `car_map_${vin}.png`);
  if (fm.fileExists(mapFile)) {
    try {
      image = fm.readImage(mapFile);
    } catch (e) {
      image = null;
    }
  }
  if ((image == null || moved) && runtimeConfig.amapApiKey) {
    try {
      const url = `https://restapi.amap.com/v3/staticmap?scale=2` +
        `&location=${geo.longitude},${geo.latitude}&zoom=15&size=150*150` +
        `&markers=mid,0xFF4444,A:${geo.longitude},${geo.latitude}` +
        `&key=${runtimeConfig.amapApiKey}`;
      const req = new Request(url);
      image = await req.loadImage();
      fm.writeImage(mapFile, image);
    } catch (e) {
      // 异常对象可能包含带高德 Key 的完整 URL，仅输出固定文案
      console.log("静态地图加载失败");
      if (image == null && fm.fileExists(mapFile)) {
        try { image = fm.readImage(mapFile); } catch (e2) {}
      }
    }
  }

  // 地图请求失败且无缓存时创建透明占位图，保证右栏布局不中断
  if (image == null) {
    const placeholder = new DrawContext();
    placeholder.opaque = false;
    placeholder.size = new Size(300, 300);
    image = placeholder.getImage();
  }

  return { geofence: geofence, latitude: lat, longitude: lng, lat: geo.latitude, lng: geo.longitude, image: image };
}

// ============================ 渲染工具 ============================

/** 安全获取 SF Symbol 图标：老系统或符号名不支持时返回 null 而不崩溃 */
function safeSymbol(name) {
  try {
    const symbol = SFSymbol.named(name);
    return symbol ? symbol.image : null;
  } catch (e) {
    return null;
  }
}

/**
 * 依据角度计算圆环/箭头顶点在画布中的坐标（正上方为 0 度）。
 * 入参为半径、角度与圆心坐标；返回整数 [x, y]。画布 y 轴向下，用 90 度补角匹配。
 */
function calculateSidesLength(length, angle, size) {
  const angleA = 90 * Math.PI / 180;
  const angleB = (90 - angle) * Math.PI / 180;
  const angleC = angle * Math.PI / 180;
  const y = length * Math.sin(angleB) / Math.sin(angleA);
  const x = length * Math.sin(angleC) / Math.sin(angleA);
  return [size + parseInt(x.toFixed(0)), size - parseInt(y.toFixed(0))];
}

// ============================ 锁屏圆形 Widget ============================

/**
 * 渲染锁屏圆形电量 Widget：黑色底环 + 白色进度点环 + 中央状态图标。
 * 与 Telsa Car.js 视觉一致；无数字文本，电量靠环的弧长表达。
 */
function renderAccessoryWidget(data, vin) {
  const status = data.status;
  const soc = status.totalSoc != null ? status.totalSoc : (status.soc1 || 0);
  const widget = data.widget;

  const circle = new DrawContext();
  circle.size = new Size(100, 100);
  circle.opaque = false;

  circle.setStrokeColor(Color.black());
  circle.setLineWidth(10);
  circle.strokeEllipse(new Rect(5, 5, 90, 90));

  circle.setFillColor(Color.white());
  const width = 8;
  for (let angle = 0; angle <= 360 / 100 * soc; angle += 1) {
    const loc = calculateSidesLength(45, angle, 50);
    circle.fillEllipse(new Rect(loc[0] - width/2, loc[1] - width/2, width, width));
  }

  // 中央状态图标：充电用闪电，其他用车辆图形
  let iconName = "bicycle";
  if (status.chgStatus === 1) iconName = "bolt.fill";
  const icon = safeSymbol(iconName);
  if (icon) {
    circle.drawImageAtPoint(icon, new Point(30, 34));
  }

  const image = widget.addImage(circle.getImage());
  image.borderWidth = 0;

  Script.setWidget(widget);
  widget.presentSmall();
}

// ============================ 中号桌面 Widget ============================

/**
 * 渲染中号桌面 Widget：左信息栏（190pt）+ 右地图栏（176pt）。
 * 入参为 runtimeContext、runtimeConfig 与完整 vehicle 数据；无返回值。
 */
async function renderMediumWidget(runtimeContext, runtimeConfig, data, vin) {
  const { fm, widget } = runtimeContext;
  widget.backgroundColor = new Color("#292929", 100);

  const vehicle = await loadCarContext(runtimeContext, runtimeConfig, data, vin);
  const status = vehicle.status;
  const soc = status.totalSoc != null ? status.totalSoc : (status.soc1 || 0);
  const charging = status.chgStatus === 1;
  const riding = status.rideStatus === 1;

  // 刷新策略：骑行 10 秒 / 充电 30 秒 / 其他 60 秒（refreshAfterDate 只是最早刷新时间）
  if (riding) {
    widget.refreshAfterDate = new Date(Date.now() + 1000 * 10);
  } else if (charging) {
    widget.refreshAfterDate = new Date(Date.now() + 1000 * 30);
  } else {
    widget.refreshAfterDate = new Date(Date.now() + 1000 * 60);
  }

  /**
   * 创建中号 Widget 左右两栏基础布局（与 Telsa Car.js 同构）：
   * 左栏 190×176 + padding(15,25,15,25)，右栏 176×176 地图面板，间距 10。
   */
  function createMediumLayout() {
    const layout = widget.addStack();
    layout.layoutVertically();

    const main = layout.addStack();
    main.layoutHorizontally();

    const left = main.addStack();
    left.layoutVertically();
    left.size = new Size(190, MEDIUM_WIDGET_HEIGHT);
    left.setPadding(15, 25, 15, 25);

    main.addSpacer(10);

    const right = main.addStack();
    right.layoutVertically();
    right.size = new Size(MAP_PANEL_SIZE, MEDIUM_WIDGET_HEIGHT);
    right.setPadding(0, 0, 0, 0);

    return { left: left, right: right };
  }

  const { left, right } = createMediumLayout();

  /**
   * 首行：显示名 + 状态图标 + 胎压告警图标（对齐 Telsa renderCarInfo）。
   */
  function renderCarInfo() {
    const stack = left.addStack();
    stack.centerAlignContent();
    stack.setPadding(0, 0, 0, 0);
    stack.size = new Size(150, 20);

    // 显示名：爱车昵称优先，其次车型名
    const displayName = vehicle.bikeNickName || vehicle.modelName || ("雅迪 " + (status.vin || vin).slice(-6));
    const name = stack.addText(displayName + "           ");
    name.font = Font.mediumSystemFont(16);
    name.lineLimit = 1;
    name.minimumScaleFactor = 0.6;

    stack.addSpacer(3);

    // 胎压告警：任一 warning 字段非零即显示黄色图标
    if ((status.leftFrontPressureWarning || 0) > 0 || (status.leftRearPressureWarning || 0) > 0) {
      const tire = safeSymbol("exclamationmark.tirepressure");
      if (tire) {
        const img = stack.addImage(tire);
        img.tintColor = Color.yellow();
        img.imageSize = new Size(16, 16);
      }
    }

    stack.addSpacer(5);
    let symbolName = null;
    let color = Color.white();
    // 状态图标与颜色映射（对齐 Telsa 的 circle 系列风格）
    if (status.onlineState === false) {
      symbolName = "wifi.exclamationmark.circle";
      color = Color.red();
    } else if (charging) {
      symbolName = "bolt.circle";
      color = Color.green();
    } else if (riding) {
      symbolName = "car.circle";
      color = Color.green();
    } else {
      symbolName = "parkingsign.circle";
      color = Color.green();
    }
    const symbol = safeSymbol(symbolName);
    if (symbol) {
      const img = stack.addImage(symbol);
      img.tintColor = color;
      img.imageSize = new Size(18, 18);
    }
  }

  /**
   * 电池图 + 剩余续航 + 数据年龄计时器（对齐 Telsa renderBatteryInfo）。
   * 电池外壳白色/绿色，黑色遮罩覆盖未充电部分，电量数字内嵌电池图形。
   */
  function renderBatteryInfo() {
    left.addSpacer(15);

    const stack = left.addStack();
    stack.centerAlignContent();

    const height = 14;
    const battery = new DrawContext();
    battery.opaque = false;
    battery.size = new Size(50, 16);
    const path = new Path();
    path.addRoundedRect(new Rect(0, 0, 42, height), 2, 2);
    path.addRoundedRect(new Rect(43, height / 4, 3, height / 2), 1, 1);
    battery.addPath(path);
    battery.setFillColor(charging ? Color.green() : Color.white());
    battery.fillPath();

    // 未充电部分以黑色遮罩挖空（雅迪无充电上限概念，遮罩宽度 = 100 - soc）
    const maskWidth = (100 - soc) / 100 * 40;
    const draw = new DrawContext();
    draw.opaque = false;
    draw.size = new Size(42, height - 2);
    const maskPath = new Path();
    maskPath.addRoundedRect(new Rect(0, 0, maskWidth, height - 2), 1, 1);
    draw.addPath(maskPath);
    draw.setFillColor(Color.black());
    draw.fillPath();
    battery.drawImageAtPoint(draw.getImage(), new Point(41 - maskWidth, 1));

    // 电量数字内嵌电池图形中央
    battery.setFont(Font.mediumSystemFont(11));
    battery.setTextAlignedCenter();
    battery.setTextColor(charging ? Color.white() : Color.black());
    battery.drawText(String(soc), new Point(14, 0));

    const image = stack.addImage(battery.getImage());
    image.imageSize = new Size(50, height);

    // 剩余续航
    stack.addSpacer(5);
    stack.centerAlignContent();
    const km = `${status.remMileage != null ? status.remMileage : "-"}`.split(".")[0];
    const text = stack.addText(km + "km       ");
    text.textColor = charging ? Color.green() : Color.white();
    text.font = Font.mediumSystemFont(12);
    text.leftAlignText();

    // 数据年龄计时器：以采集时间为起点的正计时（对齐 Telsa 的 addDate 用法）
    const collectTime = status.collectTime || vehicle.fetchedAt || Date.now();
    const timer = stack.addDate(new Date(collectTime));
    timer.size = new Size(30, 20);
    timer.applyTimerStyle();
    timer.minimumScaleFactor = 0.5;
    timer.font = Font.mediumSystemFont(12);
    timer.lineLimit = 1;
    timer.textColor = Color.gray();
    timer.rightAlignText();
  }

  /**
   * 仅充电中显示充电信息行（对齐 Telsa renderChargingStatus）。
   * realTimeChargeWatt 单位未确认，只显示原始值 + W；剩余时间由 remainChgTime1 换算。
   */
  function renderChargingStatus() {
    if (!charging) return;
    let timeText = "";
    const remainMs = status.remainChgTime1 || 0;
    if (remainMs > 0) {
      const totalMin = Math.floor(remainMs / 60000);
      const hour = Math.floor(totalMin / 60);
      const min = totalMin - hour * 60;
      if (hour > 0) timeText = hour + "h";
      if (min > 0) timeText = timeText + min + "m";
    }
    left.addSpacer(8);
    const line = left.addText(" ⚡ " + (status.realTimeChargeWatt != null ? status.realTimeChargeWatt + "W" : "充电中") +
      (timeText ? " → " + timeText : "") + "        ");
    line.lineLimit = 1;
    line.font = Font.mediumSystemFont(12);
    line.textColor = Color.green();
  }

  /**
   * 核心数据行：电压 / SOH / 循环 / 电池温度（对应 Telsa 状态图标行的位置）。
   * 雅迪无锁/车窗等控制状态数据，改用文本概览占位同一布局行。
   */
  function renderBikeStats() {
    left.addSpacer(15);
    const stack = left.addStack();
    const items = [];
    if (status.volt != null) items.push(status.volt + "V");
    if (vehicle.batt && vehicle.batt.soh != null) items.push("SOH " + vehicle.batt.soh + "%");
    if (status.battCyc1 != null) items.push("循环" + status.battCyc1);
    if (status.mosTemp1 != null) items.push(status.mosTemp1 + "℃");
    const text = stack.addText(items.join(" · "));
    text.font = Font.mediumSystemFont(12);
    text.textColor = Color.white();
    text.lineLimit = 1;
    text.minimumScaleFactor = 0.6;
  }

  /**
   * 底部：数据时间 + 位置名称（对齐 Telsa renderLocationInfo）。
   */
  function renderLocationInfo() {
    left.addSpacer(15);
    const stack = left.addStack();
    const desc = humanizeAge(Date.now() - (vehicle.fetchedAt || status.collectTime || Date.now()));
    const text = stack.addText(desc + " · " + (vehicle.car_geo.geofence || "未知位置"));
    text.font = Font.mediumSystemFont(12);
    text.textColor = Color.gray();
    text.lineLimit = 2;
  }

  /**
   * 右栏地图与位置标记（对齐 Telsa renderMap）。
   * 雅迪无航向角数据，以白色圆点 + 蓝色内点替代方向箭头，避免误导。
   */
  function renderMap() {
    const stack = right.addStack();
    stack.setPadding(0, 0, 0, 0);
    stack.size = new Size(MAP_PANEL_SIZE, MEDIUM_WIDGET_HEIGHT);

    const map = new DrawContext();
    map.opaque = false;
    map.size = new Size(300, 300);
    map.drawImageAtPoint(vehicle.car_geo.image, new Point(0, 0));

    // 中心位置标记：白色外圈 + 蓝色内点
    const dot = new DrawContext();
    dot.opaque = false;
    dot.size = new Size(40, 40);
    dot.setFillColor(Color.white());
    dot.fillEllipse(new Rect(6, 6, 28, 28));
    dot.setFillColor(Color.blue());
    dot.fillEllipse(new Rect(13, 13, 14, 14));
    map.drawImageAtPoint(dot.getImage(), new Point(130, 130));

    const image = stack.addImage(map.getImage());
    image.rightAlignImage();
    image.imageSize = new Size(MAP_PANEL_SIZE, MEDIUM_WIDGET_HEIGHT);
    image.applyFillingContentMode();
    image.cornerRadius = 0;
    image.url = `http://maps.apple.com/?ll=${vehicle.car_geo.latitude},${vehicle.car_geo.longitude}&q=` +
      encodeURI(vehicle.bikeNickName || vehicle.modelName || "车辆位置");
  }

  renderCarInfo();
  renderBatteryInfo();
  renderChargingStatus();
  renderBikeStats();
  renderLocationInfo();
  renderMap();

  Script.setWidget(widget);
  widget.presentMedium();
}

// ============================ 车辆上下文组装 ============================

/**
 * 组装中号 Widget 的车辆上下文（对齐 Telsa loadCarContext）：
 * 上一坐标 -> 逆地理与地图 -> 显示名缓存 -> 写回。
 * 入参为 runtimeContext、runtimeConfig 与 loadVehicleDataWithCache 的结果；返回补充字段的对象。
 */
async function loadCarContext(runtimeContext, runtimeConfig, data, vin) {
  const fm = runtimeContext.fm;
  const status = data.status;
  const file = fm.joinPath(runtimeContext.fileRoot, `car_data_${vin}.json`);

  // 上一坐标：来自上次写回的缓存；首次以当前坐标初始化
  let prevCoord = null;
  try {
    const prevRaw = fm.readString(file);
    const prevData = JSON.parse(prevRaw);
    if (prevData && prevData.status) {
      prevCoord = { lat: prevData.status.lat, lng: prevData.status.lon };
    }
  } catch (e) {
    prevCoord = null;
  }

  const curCoord = { lat: status.lat, lng: status.lon };
  data.prev_coord = prevCoord || curCoord;

  data.car_geo = await getCarGeo(
    runtimeContext, runtimeConfig, vin, status, data.prev_coord,
    curCoord.lat, curCoord.lng
  );

  // 显示名缓存：昵称优先，接口失败不影响主流程
  data.bikeNickName = "";
  data.modelName = "";
  const nameFile = fm.joinPath(runtimeContext.fileRoot, `car_name_${vin}.json`);
  let nameCache = null;
  try {
    if (fm.fileExists(nameFile)) nameCache = JSON.parse(fm.readString(nameFile));
  } catch (e) {
    nameCache = null;
  }
  if (nameCache && (nameCache.bikeNickName || nameCache.modelName)) {
    data.bikeNickName = nameCache.bikeNickName || "";
    data.modelName = nameCache.modelName || "";
  } else {
    try {
      const bikes = await getBindingBikes(runtimeConfig);
      const mine = bikes.find(b => b.vin === vin) || bikes[0];
      if (mine) {
        data.bikeNickName = mine.bikeNickName || "";
        data.modelName = mine.modelName || "";
        fm.writeString(nameFile, JSON.stringify({ bikeNickName: data.bikeNickName, modelName: data.modelName }));
      }
    } catch (e) {
      console.log("车辆列表获取失败");
    }
  }

  return data;
}

// ============================ 主流程 ============================

/**
 * 解析本次运行使用的 VIN。入参为运行配置；返回字符串。
 * 优先级：配置 VIN > Widget 参数 > 在线车辆列表第一辆。
 */
async function resolveVin(runtimeConfig) {
  if (runtimeConfig.vin) return runtimeConfig.vin;
  const param = (args.widgetParameter || "").trim();
  if (/^\d+$/.test(param)) return param;
  const bikes = await getBindingBikes(runtimeConfig);
  if (!bikes || !bikes.length) throw new Error("未找到绑定车辆");
  return bikes[0].vin;
}

/** 渲染配置未就绪的静态提示 Widget：零网络、零缓存副作用 */
function renderUnavailableConfigWidget() {
  const widget = new ListWidget();
  const text = widget.addText("等待 iCloud 配置同步\n请在 Scriptable 中运行脚本检查配置");
  text.font = Font.mediumSystemFont(12);
  text.textColor = Color.gray();
  text.lineLimit = 3;
  Script.setWidget(widget);
  if (config.widgetFamily === "accessoryCircular") {
    widget.presentSmall();
  } else {
    widget.presentMedium();
  }
}

/**
 * App 内配置缺失/异常时的受限操作菜单。
 * 入参为配置状态；返回用户选择的新配置或 null（取消/仍不可用）。
 */
async function presentNonReadyConfigInApp(configState) {
  if (configState.status === "missing") {
    const menu = new Alert();
    menu.title = "尚未配置";
    menu.message = "未找到 iCloud 配置文件";
    menu.addAction("创建新配置");
    menu.addCancelAction("取消");
    const choice = await menu.presentAlert();
    if (choice === 0) {
      return presentConfigForm(null);
    }
    return null;
  }
  if (configState.status === "unavailable") {
    await presentMessage("iCloud 未同步", "配置文件尚未下载，请稍后重试或检查 iCloud");
    return null;
  }
  // invalid：仅在用户明确确认后重建
  const menu = new Alert();
  menu.title = "配置已损坏";
  menu.message = "iCloud 配置内容无效，是否重新创建？";
  menu.addAction("重新创建配置");
  menu.addCancelAction("取消");
  const choice = await menu.presentAlert();
  if (choice === 0) {
    return presentConfigForm(null);
  }
  return null;
}

/**
 * 唯一运行入口：先执行 iCloud 配置门禁，再按运行上下文分发。
 */
async function main() {
  const runsInApp = config.runsInApp;
  const configState = loadRuntimeConfig(runsInApp);

  // Widget 上下文：任何非 ready 状态只显示静态同步提示，零网络零缓存
  if (!runsInApp) {
    if (configState.status !== "ready") {
      renderUnavailableConfigWidget();
      return;
    }
    const runtimeContext = createRuntimeContext();
    const runtimeConfig = configState.value;
    runtimeConfig.vin = runtimeConfig.vin || (args.widgetParameter || "").trim();

    let vin = runtimeConfig.vin;
    if (!vin) {
      // 无 VIN 配置：从本地 auto 记录读取上次 VIN，避免 Widget 额外请求
      const autoFile = runtimeContext.fm.joinPath(runtimeContext.fileRoot, "car_vin_auto.json");
      try {
        const nc = JSON.parse(runtimeContext.fm.readString(autoFile));
        vin = nc && nc.vin;
      } catch (e) {
        vin = null;
      }
      if (!vin) {
        vin = await resolveVin(runtimeConfig);
        runtimeContext.fm.writeString(autoFile, JSON.stringify({ vin: vin }));
      }
    }

    const dataFile = runtimeContext.fm.joinPath(runtimeContext.fileRoot, `car_data_${vin}.json`);
    const data = await loadVehicleDataWithCache(runtimeConfig, runtimeContext.fm, dataFile);
    if (config.widgetFamily === "accessoryCircular" || config.runsInAccessoryWidget) {
      renderAccessoryWidget({ status: data.status, widget: runtimeContext.widget }, vin);
    } else {
      await renderMediumWidget(runtimeContext, runtimeConfig, data, vin);
    }
    return;
  }

  // App 上下文
  let runtimeConfig = null;
  if (configState.status === "ready") {
    runtimeConfig = configState.value;
  } else {
    const created = await presentNonReadyConfigInApp(configState);
    if (!created) return;
    runtimeConfig = created;
  }

  const menu = new Alert();
  menu.title = "雅迪电动车组件";
  menu.message = "配置已就绪";
  menu.addAction("查看当前数据");
  menu.addAction("管理配置");
  menu.addCancelAction("取消");
  const choice = await menu.presentSheet();
  if (choice === 1) {
    await presentConfigForm(runtimeConfig);
    return;
  }
  if (choice !== 0) return;

  // 查看当前数据（App 内调试输出）
  const runtimeContext = createRuntimeContext();
  const vin = await resolveVin(runtimeConfig);
  const dataFile = runtimeContext.fm.joinPath(runtimeContext.fileRoot, `car_data_${vin}.json`);
  const data = await loadVehicleDataWithCache(runtimeConfig, runtimeContext.fm, dataFile);
  const soc = data.status.totalSoc != null ? data.status.totalSoc : (data.status.soc1 || 0);
  console.log(JSON.stringify(data, null, 2));
  // 显示名从本地昵称缓存读取，避免额外请求
  let displayName = "雅迪电动车";
  try {
    const nameFile = runtimeContext.fm.joinPath(runtimeContext.fileRoot, `car_name_${vin}.json`);
    const nc = JSON.parse(runtimeContext.fm.readString(nameFile));
    displayName = nc.bikeNickName || nc.modelName || displayName;
  } catch (e) {}
  const alert = new Alert();
  alert.title = displayName;
  alert.message =
    `电量 ${soc}% · 续航 ${data.status.remMileage}km\n` +
    `总里程 ${data.status.totalMileage}km · VIN ${data.status.vin}`;
  alert.addAction("好");
  await alert.presentAlert();
}

await main()
  .catch(err => {
    console.error("雅迪状态获取失败: " + (err && err.message ? err.message : "未知错误"));
    if (!config.runsInApp) {
      const widget = new ListWidget();
      const text = widget.addText("雅迪\n" + (err && err.message ? err.message : "获取失败"));
      text.font = Font.mediumSystemFont(12);
      text.textColor = Color.red();
      Script.setWidget(widget);
      if (config.widgetFamily === "accessoryCircular") widget.presentSmall();
      else widget.presentMedium();
    }
  })
  .finally(() => {
    Script.complete();
  });
