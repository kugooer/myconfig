/*************************

  泰康在线（微信小程序 wx9e3e7020c4a10356）每日领金币

  更新时间: 2026-09-01 (v1.3 打卡步数门槛分类)
  脚本兼容: QuantumultX, Surge, Loon, Node.js
  语法参考: NobyDa/JD_DailyBonus.js

  v1.2 修复（2026-08-31 逆向自小程序 getSignature）:
  - 根因：3 个打卡(draw)接口的 Signature 是 per-request、绑定未传输的
    时间戳/随机数（分钟粒度），服务端做「新鲜度」校验 → frozen Signature 必失效
    （返回泛化文案 200001000001「网络有点拥挤」掩盖真实「签名无效」）。
  - 方案：从 Mac 微信沙盒小程序包(wxF 324 版)逆向出签名算法，在脚本内用纯 JS
    内嵌 MD5 + AES-128-ECB(PKCS7) 实时算出合法 Signature（已与 Node crypto 逐字节
    对拍一致，并 live 验证服务端接受）。draw 三项改为 dynamicSignature: true。
  - 登录签到(sign)接口本就不带 Signature，原样保留 frozen payload 即可（+5 金币）。
  - 代价：Signature 用 prd 环境常量，会随小程序版本升级(包体/key 变更)失效，
    届时需重新从新包逆向；但 encData/Authorization 仍走 frozen payload，
    预计可用至 accessToken 过期(~2026-09-06)，之后 4 项一起需重新抓包。

  v1.3 修复（2026-09-01 09:32 次日实测）:
  - 现象：签名打通后打卡改报 200007700012「任务未完成」（不再是签名错 200001000001）。
  - 定性：活动 springOuting 为 H5 页（不在小程序原生包），客户端不传步数
    （全包无 werun/getWeRunData/pedometer），步数由服务端从微信运动同步后校验。
    09:32 已同步步数但仍未完成 → 当日清晨步数未达 1000 门槛，服务端拒发。
  - 方案：新增 SKIP_CODES，将 200007700012 归为「今日条件未满足」，不计失败、不告警，
    通知显示 ⏳「任务未完成 · 今日暂不可领」。四分类：成功 / 已完成 / 未达标 / 失败。
  - 结论：打卡任务需先打开小程序触发微信步数同步（服务端拿到步数即判完成，非严格步数阈值；
    2026-09-02 用户清晨打开小程序后 3 档全领成功即证）。自动化关键是「脚本运行前用户已打开过
    小程序」，而非步数达 1000/5000/10000 门槛。建议保留 09:32 尝试 + 增设晚些保底触发，
    或用户打开后手动/快捷指令触发；未打开过小程序的日子静默跳过属正常。

  v1.1 修复（2026-08-30 15:46 用户首跑日志）:
  - 「今日已签到」(200004200003) 原判为失败，现列入 DONE_CODES 视为成功
    该码同时证明 frozen payload 有效：服务端成功解密 13 分钟前的 encData 并识别用户
  - 结果三分类: 领取成功 / 今日已完成 / 失败（通知副标题区分）
  - 非终态错误（含 200001000001）自动重试 2 次，间隔 1.5s
  - 完整原始响应落盘 Taikang_LastReplay_N 供排障
  - 补入凭证有效期（JWT 解码）与已知业务码表

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

  凭证有效期（2026-08-30 解码 tkol-api/member/login 返回的 JWT 得出）:
  - accessToken  exp = 2026-09-06 15:32:59（抓包后约 7 天）
  - refreshToken exp = 2026-09-29 15:32:59（抓包后约 30 天）
  - 结论: frozen payload 预计可用到 2026-09-06 前后。到期后 4 项会一起失败，
    届时需重新抓包替换 Payloads

  已知业务码:
  - 200004200003 = 今日已签到（视为成功，已列入 DONE_CODES）
  - 200001000001 = 网络有点拥挤，请稍后重试。
    ★ 已定性（2026-08-31 09:32 次日首跑 + 手动补打卡抓包比对）：
      该码是「打卡接口 Signature 校验失败」的泛化文案，并非「已领取」。
      证据：手动打卡成功的请求与脚本 frozen 值逐项比对 → Authorization 完全相同、
      encData(请求体) 逐字节相同，唯独 Signature 后 48 字节不同（前 48 字节固定）。
      说明 draw 接口的 Signature 是 per-request、绑定一个未在请求中传输的
      时间戳/随机数，服务端做「新鲜度」校验 → frozen Signature 必失效。
      ⇒ 结论：3 个打卡接口无法通过 frozen payload 原样重放自动化，
         不要把它补进 DONE_CODES（那会掩盖真正的失败）。
  - 200007700012 = 任务未完成（服务端校验当日步数/任务状态未达标）。
    ★ 已定性（2026-09-01 09:32 次日实测）：签名打通后出现的业务码。
      活动 springOuting 为 H5 页（不在小程序原生包），客户端不传步数
      （全包搜不到 werun/getWeRunData/pedometer），步数由服务端从微信运动
      同步后校验。09:32 已同步步数但仍报未完成 → 当日清晨步数未达 1000 门槛。
      ⇒ 该码属「今日条件未满足」，已列入 SKIP_CODES，不计失败、不告警；
        定时任务需改到当日步数达标之后（建议 20:00–22:00）方可领取成功。

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

// ================= 纯 JS MD5 + AES-128-ECB(PKCS7) =================
// 用于 QX/JSContext 环境（无 crypto 模块）。已用 Node crypto 严格对拍逐字节一致。
// 用途：实时计算 draw 接口的 per-request Signature（详见下方 tkGetSignature）。
// ---- MD5 ----
function MD5(str){
  var bytes=[];
  var s0=(typeof unescape==='function')?unescape(encodeURIComponent(str)):str;
  for(var i=0;i<s0.length;i++) bytes.push(s0.charCodeAt(i)&0xff);
  var n=bytes.length;
  bytes.push(0x80);
  while(bytes.length%64!==56) bytes.push(0);
  var bitLen=n*8;
  for(var k=0;k<4;k++) bytes.push((bitLen>>>(k*8))&0xff);
  var hi=Math.floor(bitLen/0x100000000);
  for(var k=0;k<4;k++) bytes.push((hi>>>(k*8))&0xff);
  function rol(x,s){x=x>>>0;return ((x<<s)|(x>>>(32-s)))>>>0;}
  function F(x,y,z){return (x&y)|(~x&z);}
  function G(x,y,z){return (x&z)|(y&~z);}
  function H(x,y,z){return x^y^z;}
  function I(x,y,z){return y^(x|~z);}
  function step(a,b,c,d,x,s,ac,fn){var t=((a+fn(b,c,d)+x+ac)>>>0);return (rol(t,s)+b)>>>0;}
  function toInt(off){return (bytes[off]|(bytes[off+1]<<8)|(bytes[off+2]<<16)|(bytes[off+3]<<24))>>>0;}
  var h=[0x67452301,0xEFCDAB89,0x98BADCFE,0x10325476];
  var T1=[0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821];
  var T2=[0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a];
  var T3=[0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665];
  var T4=[0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];
  for(var off=0;off<bytes.length;off+=64){
    var M=[];for(var i2=0;i2<16;i2++) M[i2]=toInt(off+i2*4);
    var A=h[0],B=h[1],C=h[2],D=h[3];
    A=step(A,B,C,D,M[0],7,T1[0],F);D=step(D,A,B,C,M[1],12,T1[1],F);C=step(C,D,A,B,M[2],17,T1[2],F);B=step(B,C,D,A,M[3],22,T1[3],F);
    A=step(A,B,C,D,M[4],7,T1[4],F);D=step(D,A,B,C,M[5],12,T1[5],F);C=step(C,D,A,B,M[6],17,T1[6],F);B=step(B,C,D,A,M[7],22,T1[7],F);
    A=step(A,B,C,D,M[8],7,T1[8],F);D=step(D,A,B,C,M[9],12,T1[9],F);C=step(C,D,A,B,M[10],17,T1[10],F);B=step(B,C,D,A,M[11],22,T1[11],F);
    A=step(A,B,C,D,M[12],7,T1[12],F);D=step(D,A,B,C,M[13],12,T1[13],F);C=step(C,D,A,B,M[14],17,T1[14],F);B=step(B,C,D,A,M[15],22,T1[15],F);
    A=step(A,B,C,D,M[1],5,T2[0],G);D=step(D,A,B,C,M[6],9,T2[1],G);C=step(C,D,A,B,M[11],14,T2[2],G);B=step(B,C,D,A,M[0],20,T2[3],G);
    A=step(A,B,C,D,M[5],5,T2[4],G);D=step(D,A,B,C,M[10],9,T2[5],G);C=step(C,D,A,B,M[15],14,T2[6],G);B=step(B,C,D,A,M[4],20,T2[7],G);
    A=step(A,B,C,D,M[9],5,T2[8],G);D=step(D,A,B,C,M[14],9,T2[9],G);C=step(C,D,A,B,M[3],14,T2[10],G);B=step(B,C,D,A,M[8],20,T2[11],G);
    A=step(A,B,C,D,M[13],5,T2[12],G);D=step(D,A,B,C,M[2],9,T2[13],G);C=step(C,D,A,B,M[7],14,T2[14],G);B=step(B,C,D,A,M[12],20,T2[15],G);
    A=step(A,B,C,D,M[5],4,T3[0],H);D=step(D,A,B,C,M[8],11,T3[1],H);C=step(C,D,A,B,M[11],16,T3[2],H);B=step(B,C,D,A,M[14],23,T3[3],H);
    A=step(A,B,C,D,M[1],4,T3[4],H);D=step(D,A,B,C,M[4],11,T3[5],H);C=step(C,D,A,B,M[7],16,T3[6],H);B=step(B,C,D,A,M[10],23,T3[7],H);
    A=step(A,B,C,D,M[13],4,T3[8],H);D=step(D,A,B,C,M[0],11,T3[9],H);C=step(C,D,A,B,M[3],16,T3[10],H);B=step(B,C,D,A,M[6],23,T3[11],H);
    A=step(A,B,C,D,M[9],4,T3[12],H);D=step(D,A,B,C,M[12],11,T3[13],H);C=step(C,D,A,B,M[15],16,T3[14],H);B=step(B,C,D,A,M[2],23,T3[15],H);
    A=step(A,B,C,D,M[0],6,T4[0],I);D=step(D,A,B,C,M[7],10,T4[1],I);C=step(C,D,A,B,M[14],15,T4[2],I);B=step(B,C,D,A,M[5],21,T4[3],I);
    A=step(A,B,C,D,M[12],6,T4[4],I);D=step(D,A,B,C,M[3],10,T4[5],I);C=step(C,D,A,B,M[10],15,T4[6],I);B=step(B,C,D,A,M[1],21,T4[7],I);
    A=step(A,B,C,D,M[8],6,T4[8],I);D=step(D,A,B,C,M[15],10,T4[9],I);C=step(C,D,A,B,M[6],15,T4[10],I);B=step(B,C,D,A,M[13],21,T4[11],I);
    A=step(A,B,C,D,M[4],6,T4[12],I);D=step(D,A,B,C,M[11],10,T4[13],I);C=step(C,D,A,B,M[2],15,T4[14],I);B=step(B,C,D,A,M[9],21,T4[15],I);
    h[0]=(h[0]+A)>>>0;h[1]=(h[1]+B)>>>0;h[2]=(h[2]+C)>>>0;h[3]=(h[3]+D)>>>0;
  }
  function hx(v){var s="";for(var i=0;i<4;i++){var b=(v>>>(i*8))&0xff;s+=("0"+b.toString(16)).slice(-2);}return s;}
  return hx(h[0])+hx(h[1])+hx(h[2])+hx(h[3]);
}
// ---- AES-128-ECB (FIPS-197) ----
var AES_SBOX=[99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22];
var AES_RCON=[0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];
function aesKeyExpand(key){var w=[];for(var i=0;i<4;i++)w[i]=(key[4*i]<<24)|(key[4*i+1]<<16)|(key[4*i+2]<<8)|key[4*i+3];for(var i=4;i<44;i++){var temp=w[i-1];if(i%4===0){var b=(temp>>>24)&255,g=(temp>>>16)&255,r=(temp>>>8)&255,lf=temp&255;temp=((AES_SBOX[b]<<24)|(AES_SBOX[g]<<16)|(AES_SBOX[r]<<8)|AES_SBOX[lf]);temp=((temp<<8)|(temp>>>24))^(AES_RCON[(i>>2)-1]<<24);}w[i]=w[i-4]^temp;}return w;}
function aesStateFromBytes(b){var s=[];for(var c=0;c<4;c++){s[c]=0;for(var r=0;r<4;r++)s[c]|=(b[c*4+r])<<(24-r*8);}return s;}
function aesStateToBytes(s){var b=[];for(var c=0;c<4;c++){for(var r=0;r<4;r++)b[c*4+r]=(s[c]>>>(24-r*8))&255;}return b;}
function aesAddRoundKey(s,w,round){var t=[];for(var c=0;c<4;c++)t[c]=s[c]^w[round*4+c];return t;}
function aesSubBytes(s){var t=[];for(var c=0;c<4;c++){var v=0;for(var r=0;r<4;r++){var byte=(s[c]>>>(24-r*8))&255;v|=AES_SBOX[byte]<<(24-r*8);}t[c]=v;}return t;}
function aesShiftRows(s){var t=[];for(var c=0;c<4;c++){var v=0;for(var r=0;r<4;r++){var srcCol=(c+r)%4;var byte=(s[srcCol]>>>(24-r*8))&255;v|=byte<<(24-r*8);}t[c]=v;}return t;}
function aesMul(a,b){var p=0;for(var i=0;i<8;i++){if(b&1)p^=a;b=b>>1;if(b)a=a<<1;if(a&0x100)a^=0x11b;}return p&0xff;}
function aesMixColumns(s){var t=[];for(var c=0;c<4;c++){var a=[(s[c]>>>24)&255,(s[c]>>>16)&255,(s[c]>>>8)&255,s[c]&255];var r=[aesMul(a[0],2)^aesMul(a[1],3)^a[2]^a[3],a[0]^aesMul(a[1],2)^aesMul(a[2],3)^a[3],a[0]^a[1]^aesMul(a[2],2)^aesMul(a[3],3),aesMul(a[0],3)^a[1]^a[2]^aesMul(a[3],2)];t[c]=(r[0]<<24)|(r[1]<<16)|(r[2]<<8)|r[3];}return t;}
function aesEncryptBlock(block,key){var w=aesKeyExpand(key);var state=aesStateFromBytes(block);state=aesAddRoundKey(state,w,0);for(var round=1;round<10;round++){state=aesSubBytes(state);state=aesShiftRows(state);state=aesMixColumns(state);state=aesAddRoundKey(state,w,round);}state=aesSubBytes(state);state=aesShiftRows(state);state=aesAddRoundKey(state,w,10);return aesStateToBytes(state);}
function aes128EcbEncrypt(plainBytes,keyBytes){var pad=16-(plainBytes.length%16);if(pad===0)pad=16;var data=plainBytes.slice();for(var i=0;i<pad;i++)data.push(pad);var out=[];for(var off=0;off<data.length;off+=16){out=out.concat(aesEncryptBlock(data.slice(off,off+16),keyBytes));}return out;}
// ---- draw 接口 Signature（逆向自小程序 getSignature，prd 环境常量） ----
// 原小程序：sign = md5(md5(clientId + nonStr + 分钟时间戳 + MD5常量))
//          Signature = AES-128-ECB( JSON.stringify({clientId,nonStr,timestamp,sign}), key ).toUpperCase()
var TK_CLIENT_ID = "81b1950d";
var TK_MD5_CONST = "gc6615f3f5b85f1ec09e";
var TK_SIG_KEY   = "xdh3OmA5gEMMy0Mz";
function tkGenNonce(){
  var r="0123456789abcdef";
  var t=[];
  for(var n=0;n<36;n++) t[n]=r.substr(Math.floor(16*Math.random()),1);
  t[14]="4";
  t[19]=r.substr((3 & t[19]) | 8, 1);
  t[8]=t[13]=t[18]=t[23]="-";
  return t.join("");
}
function tkHeadAESEncrypt(keyStr, obj){
  var keyBuf=Array.prototype.map.call(keyStr, function(c){return c.charCodeAt(0);});
  var plainStr=JSON.stringify(obj);
  var plain=[];
  for(var i=0;i<plainStr.length;i++) plain.push(plainStr.charCodeAt(i)&0xff);
  var enc=aes128EcbEncrypt(plain, keyBuf);
  return enc.map(function(b){return ("0"+b.toString(16)).slice(-2);}).join("").toUpperCase();
}
function tkGetSignature(){
  var nonStr=tkGenNonce();
  var timestamp=Date.now();
  var X=TK_CLIENT_ID+nonStr+(60000*Math.floor(timestamp/60000))+TK_MD5_CONST;
  var m1=MD5(X);
  var sign=MD5(m1);
  var a={clientId:TK_CLIENT_ID,nonStr:nonStr,timestamp:timestamp,sign:sign};
  return tkHeadAESEncrypt(TK_SIG_KEY, a);
}

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
    dynamicSignature: true,
    headers: {
      "content-type": "application/json",
      "User-Agent": DefaultUA,
      "Referer": Referer,
      Authorization:
        "D8920E7A3D72DB2F1A3BB6445AB743434D329E2A092D20FAB07FAAEF7548F3E6C6255D3AA32B50945C3C1BC19C7972B9E846722A035DDB45EC0D4CBA5A3B52CEA1BB44D0C05D4934880CBEDFA584FFCE4E14C2E723EE22B69F427A74EC7962E5"
    },
    body:
      '{"enc":true,"encData":"E3D409147A3678E02E51FD53EBBEEBC45FEF6A153651A7F13309FD281461037714E925C0915945BD27FED35A9FFAAA91B39B55A86DD2591A4650D4ECFC62244CF14F4D4879CDE56F9C243CB3070EED577B627027BE376706F8A1C46CF198C64DDDCA1243715C2269C3000738B35B7DA49571D53AA805BC5E6B304D99ADA86416BD68171206DD5F49766C31FBA583CA651379011452242FE2CE24F5301CD143D7C4894BD2A9651DB907DBE6B82296D206530651C97498E71C04E53F3297CD5162456AD276E40A403FCD474F7D4C12F1540C213FF00D829D0C18AF3E4DEE1BE6212DC01E17E358859CE6F808C9226E6A77A7A84D69F7F8670A6BDD17CF07462800864182D0C02B9800A1A9B36CB2A2F0B7"}'
  },
  {
    name: "每日打卡5000步",
    expectCoin: 30,
    expectSource: "dailyFiveK",
    path: "/promotion/activity_execute/rest/springOuting/draw",
    dynamicSignature: true,
    headers: {
      "content-type": "application/json",
      "User-Agent": DefaultUA,
      "Referer": Referer,
      Authorization:
        "D8920E7A3D72DB2F1A3BB6445AB743434D329E2A092D20FAB07FAAEF7548F3E6C6255D3AA32B50945C3C1BC19C7972B9E846722A035DDB45EC0D4CBA5A3B52CEA1BB44D0C05D4934880CBEDFA584FFCE4E14C2E723EE22B69F427A74EC7962E5"
    },
    body:
      '{"enc":true,"encData":"E3D409147A3678E02E51FD53EBBEEBC45FEF6A153651A7F13309FD281461037714E925C0915945BD27FED35A9FFAAA91B39B55A86DD2591A4650D4ECFC62244CF14F4D4879CDE56F9C243CB3070EED577B627027BE376706F8A1C46CF198C64DDDCA1243715C2269C3000738B35B7DA49571D53AA805BC5E6B304D99ADA86416BD68171206DD5F49766C31FBA583CA651379011452242FE2CE24F5301CD143D7C4894BD2A9651DB907DBE6B82296D206530651C97498E71C04E53F3297CD5162456AD276E40A403FCD474F7D4C12F1540C213FF00D829D0C18AF3E4DEE1BE6212DC01E17E358859CE6F808C9226E6A77A7A84D69F7F8670A6BDD17CF07462800A7BF08B526D071E0B3E144D651F8DB8F33B11CAC113EAF7837E2DB388D690DFC"}'
  },
  {
    name: "每日打卡10000步",
    expectCoin: 50,
    expectSource: "dailyTenK",
    path: "/promotion/activity_execute/rest/springOuting/draw",
    dynamicSignature: true,
    headers: {
      "content-type": "application/json",
      "User-Agent": DefaultUA,
      "Referer": Referer,
      Authorization:
        "D8920E7A3D72DB2F1A3BB6445AB743434D329E2A092D20FAB07FAAEF7548F3E6C6255D3AA32B50945C3C1BC19C7972B9E846722A035DDB45EC0D4CBA5A3B52CEA1BB44D0C05D4934880CBEDFA584FFCE4E14C2E723EE22B69F427A74EC7962E5"
    },
    body:
      '{"enc":true,"encData":"E3D409147A3678E02E51FD53EBBEEBC45FEF6A153651A7F13309FD281461037714E925C0915945BD27FED35A9FFAAA91B39B55A86DD2591A4650D4ECFC62244CF14F4D4879CDE56F9C243CB3070EED577B627027BE376706F8A1C46CF198C64DDDCA1243715C2269C3000738B35B7DA49571D53AA805BC5E6B304D99ADA86416BD68171206DD5F49766C31FBA583CA651379011452242FE2CE24F5301CD143D7C4894BD2A9651DB907DBE6B82296D206530651C97498E71C04E53F3297CD5162456AD276E40A403FCD474F7D4C12F1540C213FF00D829D0C18AF3E4DEE1BE6212DC01E17E358859CE6F808C9226E6A77A7A84D69F7F8670A6BDD17CF074628007800DC83E13F03745A29FD54E42AECE7"}'
  }
];

// 已知「今日已完成」业务码 → 视为成功，不报警
// 注意：打卡接口的 200001000001 是 Signature 校验失败（非「已领取」），
// 绝不进 DONE_CODES，否则会掩盖真正的自动化失败
var DONE_CODES = {
  "200004200003": "今日已签到"
};
// 已知「今日条件未满足」业务码 → 视为跳过，不报警、不计入失败
// 200007700012 = 任务未完成（服务端尚无当日微信步数数据，任务无法判定完成）
// 根因（2026-09-02 实证）：打卡任务需客户端先打开小程序、由微信获取步数并同步到服务端，
//   服务端拿到步数数据后才判任务完成；仅重放 draw 而当日未打开过小程序 → 无步数 → 任务未完成。
var SKIP_CODES = {
  "200007700012": "任务未完成 · 今日暂不可领"
};
// 瞬时错误（如 200001000001「网络有点拥挤，请稍后重试」）重试次数与间隔
var RetryTimes = 2;
var RetryDelayMs = 1500;

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

// 单次请求：只负责发包，判定交给 classify()
function fetchOnce(p) {
  return new Promise((resolve) => {
    var headers = {};
    for (var k in p.headers) if (p.headers.hasOwnProperty(k)) headers[k] = p.headers[k];
    if (p.dynamicSignature) headers.Signature = tkGetSignature();
    const options = {
      url: "https://" + HOST + p.path,
      method: "POST",
      headers: headers,
      body: p.body
    };
    if (out) options.timeout = out;
    $nobyda.post(options, function (error, response, data) {
      resolve({
        error: error || null,
        status: response ? response.statusCode || response.status : 0,
        data: data
      });
    });
  });
}

// 结果判定：settled=true 表示终态（成功 / 今日已完成），不再重试
function classify(p, r) {
  if (r.error) return { ok: false, msg: "网络错误: " + r.error };
  const obj = safeJSON(r.data);
  if (!obj) return { ok: false, msg: "响应非 JSON (HTTP " + r.status + ")" };
  const code = String(obj.error_code || "");
  if (code === "0") {
    const d = obj.data || {};
    const coin = Number(d.signAmount != null ? d.signAmount : d.glodbean || 0);
    return {
      ok: true,
      settled: true,
      code: "0",
      coin: coin,
      source: d.drawSource || p.expectSource || "",
      total: Number(d.amount || d.totalGoldbeanAmount || 0),
      todayIsSub: d.todayIsSub || "",
      msg: "+" + coin + " 金币"
    };
  }
  if (DONE_CODES[code]) {
    return { ok: true, done: true, settled: true, code: code, msg: DONE_CODES[code] };
  }
  if (SKIP_CODES[code]) {
    return { ok: false, skip: true, settled: true, code: code, msg: SKIP_CODES[code] };
  }
  return {
    ok: false,
    code: code,
    msg: "业务错误 " + code + " " + (obj.error_message || "")
  };
}

async function doAction(p, index) {
  const slot = { name: p.name, expectCoin: p.expectCoin, expectSource: p.expectSource };
  merge["act" + index] = slot;
  let lastResult = null;
  let lastParsed = null;
  for (let round = 0; round <= RetryTimes; round++) {
    if (round > 0) await sleep(RetryDelayMs);
    const r = await fetchOnce(p);
    lastResult = r;
    lastParsed = classify(p, r);
    if (lastParsed.settled) break;
    if (round < RetryTimes) {
      console.log("[" + p.name + "] 第 " + (round + 1) + " 次未成功（" + lastParsed.msg + "），" + RetryDelayMs + "ms 后重试");
    }
  }
  Object.assign(slot, lastParsed || { ok: false, msg: "无响应" });
  // 完整原始响应落盘，供排障（QX: 通用设置 → 持久化 → Taikang_LastReplay_N）
  saveDiag(p, index, lastResult, lastParsed);
  logResult(p, slot);
}

function logResult(p, slot) {
  if (slot.ok && !slot.done) {
    console.log(
      "[" + p.name + "] ✅ 领取成功 +" + slot.coin + " (source=" + slot.source + ", total=" + slot.total + ", todayIsSub=" + slot.todayIsSub + ")"
    );
  } else if (slot.done) {
    console.log("[" + p.name + "] ✅ 今日已完成，无需重复 (" + slot.msg + ")");
  } else {
    console.log("[" + p.name + "] ❌ " + slot.msg);
  }
}

function saveDiag(p, index, r, parsed) {
  try {
    $nobyda.write(
      JSON.stringify({
        at: new Date().toISOString(),
        name: p.name,
        path: p.path,
        http: r && r.status,
        code: parsed && parsed.code,
        msg: parsed && parsed.msg,
        coin: parsed && parsed.coin,
        total: parsed && parsed.total,
        raw: String((r && r.data) || "").slice(0, 400)
      }),
      PREFIX + "_LastReplay_" + index
    );
  } catch (e) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  let gotCoin = 0; // 本次真正领到的
  let gotCount = 0; // 本次领取成功数
  let doneCount = 0; // 今日此前已完成数
  let skipCount = 0; // 今日条件未满足（如步数未达标）
  let failCount = 0;
  for (let i = 1; i <= Payloads.length; i++) {
    const slot = merge["act" + i];
    if (!slot) continue;
    if (slot.ok && !slot.done) {
      gotCount++;
      gotCoin += Number(slot.coin || 0);
      lines.push("✅ " + slot.name + " +" + slot.coin + " 金币");
    } else if (slot.done) {
      doneCount++;
      lines.push("☑️ " + slot.name + " 今日已完成");
    } else if (slot.skip) {
      skipCount++;
      lines.push("⏳ " + slot.name + " " + (slot.msg || "今日暂不可领"));
    } else {
      failCount++;
      lines.push("❌ " + slot.name + " " + (slot.msg || "失败"));
    }
  }
  // 账户余额取最后一个拿到 total 的响应
  let lastTotal = 0;
  for (let i = Payloads.length; i >= 1; i--) {
    if (merge["act" + i] && merge["act" + i].total) {
      lastTotal = merge["act" + i].total;
      break;
    }
  }
  const title = "泰康在线领金币";
  let sub;
  if (failCount === 0 && gotCount > 0) sub = gotCount + "/" + Payloads.length + " 领取成功 · 本次 +" + gotCoin + " 金币";
  else if (failCount === 0 && gotCount === 0 && skipCount > 0) sub = "签到已领，" + skipCount + "/" + Payloads.length + " 打卡今日暂不可领";
  else if (failCount === 0 && gotCount === 0) sub = "今日已全部领取（" + doneCount + "/" + Payloads.length + "）";
  else sub = gotCount + " 成功 / " + doneCount + " 已完成 / " + skipCount + " 未达标 / " + failCount + " 失败";

  let msg = lines.join("\n");
  if (lastTotal) msg += "\n账户余额: " + lastTotal + " 金币";
  if (failCount) {
    msg +=
      "\n\n⚠️ 有 " +
      failCount +
      " 项失败。若「登录签到」也返回鉴权类错误，说明 frozen payload 已过期：" +
      "重新打开小程序「每日签到福利」页抓包更新 Payloads。" +
      "\n若签到报「今日已签到」而打卡报业务错误，则打卡码可能是「今日已领取」，" +
      "把该码补进脚本顶部 DONE_CODES 即可。";
  }
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
