# Quantumult X 挂载地址

仓库：https://github.com/kugooer/myconfig

---

## 一、中国移动 / 移动云盘签到（已拆分）

更新说明（2026-08-20 · **重写 + 任务彻底拆分**）：
- **根因**：旧合并 rewrite 同时挂 App 与云盘；登录中国移动时若云盘后台有 `getUser`，日志会夹杂云盘签到
- **现方案**：App / 云盘各一套 rewrite + task；脚本仍共用 `CMCC_DailyBonus.js`（`argument=app|cloud`）
- 旧 `CMCC_DailyBonus.conf` / `.task` 已改为空壳弃用，更新后会清掉合并规则

### ① 中国移动 App · 签到领奖

**重写**

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/CMCC_AppSign.conf
```

**任务**

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/CMCC_AppSign.task
```

或手动：

```text
10 8 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/CMCC_DailyBonus.js, tag=移动App签到领奖, argument=app, enabled=true
```

### ② 移动云盘签到

**重写**

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/CMCC_CloudSign.conf
```

**任务**

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/CMCC_CloudSign.task
```

或手动：

```text
20 8 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/CMCC_DailyBonus.js, tag=移动云盘签到, argument=cloud, enabled=true
```

### 脚本本体（共用）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/CMCC_DailyBonus.js
```

### QX 迁移步骤（重要）

1. **删除或停用** 旧资源：`CMCC_DailyBonus.conf`、旧合并 task「移动即时签到 / CMCC_DailyBonus.task」
2. **新增** 上面①② 两套 rewrite（可只开 App、只开云盘，或都开）
3. **新增** 两套 task（或只加你需要的那一套）
4. 重写资源 → 右上角更新；MITM 按各 conf 的 hostname（勿自扩 `*.yun.139.com`）
5. App：登录中国移动 → 看 `mode app`，**不应再出现** `cloud open sign start`
6. 云盘：首次进一次「签到」页缓存 jwt；之后打开云盘或定时 `argument=cloud`

### 行为对照

| 资源 | 触发 | 是否跑云盘 |
|------|------|------------|
| App rewrite + 登录 | fingerprintLogin → domark | 否 |
| App 定时 `argument=app` | cron | 否 |
| 云盘 rewrite + 打开云盘 | getUser / tyrz / startSignIn | 是 |
| 云盘定时 `argument=cloud` | cron | 是 |

### 挂载后操作

1. App：登录/切号；建议首次打开「签到领奖」页
2. 云盘：首次进「签到」页，控制台出现 `cloud jwt cached ...`
3. jwt 失效后需再进一次签到页刷新（脚本会提示并清空旧 jwt）
   - 打开失败（无 jwt / 失效）**默认不弹系统通知**，只打控制台；真成功仍通知（`NotifyCloudOpenFail=false`）
4. 历史串号：清空 `CookiesCMCC` 与 `CMCC_SignEndpoints` 后重登

#### App 防重复 + 登录延迟（2026-08-27 起）

- **每日锁 `AppDailyOnce`（默认开）**：明文手机号当天只成功签到一次；已签返回「今日已签到（本地每日锁）」不打 `domark`；锁键 `CMCC_AppSignedDayMap`（DeleteCookie 时一并清）
- **登录后延迟 `SignDelayMs`（默认 3500ms，上限 5000）**：`fingerprintLogin` 成功后等 3-5 秒再签到；若日志 `Exception timeout` 请下调；定时 `argument=app` 独立运行兜底，每日锁保证不重复

---

## 二、比亚迪 App 签到

更新说明（2026-08-14）：
- 登录后打开「积分商城/签到」页，自动抓取 `Sign.signIn` 加密 `request`
- 定时任务复用凭证自动签到
- **不是**会员解锁类脚本；不会生成/托管 `bdpan.unlock.js` 同类内容

### 推荐（QX 重写资源 / 地址文件挂载）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/BYD_DailyBonus.conf
```

路径：`重写 → 引用 → 资源路径` 粘贴上址 → 右上角更新。

写法对照（与常见 remote rewrite 一致）：

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/BYD_DailyBonus.conf, tag=比亚迪签到, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Calendar.png, update-interval=86400, opt-parser=false, enabled=true
```

### 脚本本体

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js
```

### 定时任务

**方式 A：任务资源**

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/BYD_DailyBonus.task
```

**方式 B：手动添加**

```text
10 8 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/BYD_DailyBonus.js, tag=比亚迪签到, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Calendar.png, enabled=true
```

### 挂载后操作（capture-v5 ~ v8.1）

1. 开启 MITM，信任证书；**重写资源右上角强制更新**
2. hostname 应含：`dilinkappserver-cn.byd.auto`、`dilinkappserver.byd.auto`、`mina.byd.com`  
   **不要**加 车况 super 域名（无效）
3. **彻底杀掉比亚迪进程**后打开主 App（不是桌面小组件）
4. 我的 → **每日签到 / 积分商城 / 福利**，点一次签到
5. 现网主链路多为 `mina.byd.com` mPaaS：点签后可用 `MarkMinaAsSign=true` 标记最近网关包，再改回 false 回放
6. 对照 App 积分；把 capture/回放日志发维护者继续迭代

更多 mina 排障（bodyBytes / MarkMinaAsSign / 防重放）见本文件历史段落与 rewrite `#desc`。

---

## 三、无忧行(JegoTrip) 签到

更新说明（2026-08-31 / capture-v1.2-quiet-capture）：

- 抓包定位：`app.jegotrip.com.cn` 任务中心 H5
- `querySign`（明文）→ 选下一天 `signConfigId`（`isSign=2` 中 `completeNumber` 最小）
- `userSign`：明文 `{"signConfigId":id}`，AES-ECB 包装为 `{sec,body}`
- 密钥：`online_jego_h5` / `93EFE107DDE6DE51`（missioncenter 前端）
- 抓包对照：两账号分别到账 **+8**、**+6** 无忧币（`getUserTripCoins` 记录「签到」）
- **v1.1**：用户验收双账号「今日已签」正确；抓包路径不再打印「签到用时」；普通 cookie update 静默
- **v1.2**：移除 `app3.jegotrip.com.cn`。该域名承载无忧行电话/呼叫服务，
  被 QX 接管后会出现「无法连接到电话服务器」。签到接口实测全部走
  `app.jegotrip.com.cn`，移除不影响签到

### 推荐（QX 重写资源）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/JegoTrip_DailyBonus.conf
```

### 脚本本体

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/JegoTrip_DailyBonus.js
```

### 定时任务

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/JegoTrip_DailyBonus.task
```

或手动：

```text
15 8 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/JegoTrip_DailyBonus.js, tag=无忧行签到, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Calendar.png, enabled=true
```

### 挂载后操作

1. QX：重写 → 引用上述 conf → **右上角强制更新**；开启 MitM 并信任证书  
2. hostname 仅：`app.jegotrip.com.cn`（v1.2 起**不再**包含 `app3.jegotrip.com.cn`；勿整域 `*.jegotrip.com.cn`）  
3. 打开无忧行 → **任务中心/签到页**（每个要签的账号各进一次）  
4. 通知「凭证新增/已保存」后，手动运行「无忧行签到」任务验证  
5. 多账号按 token 去重保存在 `JegoTrip_Cookies`  
6. token 过期会提示重新进签到页；勿分享 token

### 排障：无忧行电话/呼叫不可用

若开启本重写后无忧行提示「无法连接到电话服务器」：

1. 确认 rewrite 的 `hostname` **只有** `app.jegotrip.com.cn`，不含 `app3.jegotrip.com.cn`
2. QX：MitM 设置里检查主机名列表，若残留 `app3.jegotrip.com.cn` 需更新重写资源后清理
3. 分流中为 `app3.jegotrip.com.cn`、`*.jegotrip.com.cn` 电话相关域名加 **DIRECT（直连）** 规则
4. QX 的 MitM 若开启「解密」会中断非 HTTP(S) 的信令/长连接；直连可绕过接管
5. 仍异常时，可临时停用本重写做 A/B 验证，确认是否由 MitM 引起

---

## 四、银河证券 App 签到

更新说明（2026-08-17 / capture-v1.6）：
- 抓包定位：H5 网关 `mall.chinastock.com.cn/h5_gateway/smart-trade/vip/*`
- 凭证：请求头 `Cookie: SESSION=...`（进入「智能VIP/VIP中心」H5 页面时携带）
- 签到接口：`POST /h5_gateway/smart-trade/vip/checkIn`，body `{}`
  - 响应 `{"ret":{"error":"0","msg":"操作成功"},"data":1}` → 签到成功
- **触发方式（结论）**：**必须进入「智能VIP/VIP中心」H5 页面**才能触发。
  已实测排除「登录后自动触发」：
  - v1.4 扩触发面至整个 mall 网关：登录后无任何命中（登录不走 mall 域）
  - v1.5 全域诊断 `*.chinastock.com.cn`：面容解锁/登录/启动链路只有 CDN 图片
    （infoanaly/cdns 的 jpg）与原生 API，**全域无 SESSION** → QX 重写层无登录触发点
  - v1.6 收窄回 mall 域，恢复 v1.3 可靠链路（进页即自动签）
- **主模式**：打开 App → 进入「智能VIP/VIP中心」页 → 自动签到并通知
  - v1.3 核心修复：主流程 `await` 保持脚本存活（`Promise.race` 2.5s 超时兜底），
    `$task.fetch` 回调必然执行 → 签到结果通知可靠
- 并发去抖：`GS_OpenSignLock` 120s；同日一次：`GS_AutoDate`
- 定时任务（9:30）为可选兜底（每日登录模式可忽略不挂载）

### 推荐（QX 重写资源）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/GalaxyStock_DailyBonus.conf
```

路径：`重写 → 引用 → 资源路径` 粘贴上址 → 右上角更新。

### 脚本本体

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/GalaxyStock_DailyBonus.js
```

### 定时任务（兜底，可选）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/GalaxyStock_DailyBonus.task
```

或手动：

```text
30 9 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/GalaxyStock_DailyBonus.js, tag=银河证券签到, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Calendar.png, enabled=true
```

### 挂载后操作

1. 开启 MITM，信任证书；重写资源强制更新
2. hostname 仅：`mall.chinastock.com.cn`（勿整域 `*.chinastock.com.cn`，避免拖垮 App）
3. 打开银河证券 App → **进入「智能VIP/VIP中心」页**（仅首页不请求 mall 域，MitM 不命中），看通知「SESSION 凭证已更新」
4. 之后每次打开 App，延时 1~3 秒自动签到并通知「今天签到完成…」
5. SESSION 失效（重登/过期）会提示，重新打开 App 即可刷新
6. 奖励文案默认「智能VIP 1天特权 / VIP到期日 2027-09-19」，可在脚本顶部 `RewardTip` 修改

---

## 五、微信读书签到

更新说明（2026-08-18 / capture-v1.2）：
- 抓包定位：`weread.qq.com/membership-promotions/*` 会员日活动（路线 A 明文 JSON）
- 链路：`membershipPromotions`（GET，取今日期号 `issue`）→ `receive`（POST `{"issue":...}` 领取）
  → `balance`（POST，余额校验）
- **凭证抓取放宽（v1.2）**：打开 App 首页即触发抓凭证 —— 启动接口
  `i.weread.qq.com/pay/balance` + `user/profile`（均带全局会话级 `vid+skey`，非会员日专属）；
  `membership-promotions` 保底保留
- **奖励类型兼容（v1.1）**：书币（`type=money`，分转枚）、天数（`days/day/duration/expireDays/validDays`）、
  礼品（`type=gift`）、带 `name/desc` 的奖励均正常展示；成功判定放宽，不会因类型不同误报失败
- 认证：请求头 `vid` + `skey`；**skey 短时效**（实测约 1 小时内失效，返回 `401 errCode=-2012`）
- **自动续期**：脚本捕获 `i.weread.qq.com/login` 原始 body，失效时整套重放
  → 即使返回 `errcode=-2013`（微信授权过期）服务端仍下发新 `accessToken`（= 新 skey）
  → `refreshToken` 不过期即可无限续期，无需重抓
- 实测当日奖励 2 书币 = `receive` 返回 `money:200`

### 推荐（QX 重写资源）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/WeRead_DailyBonus.conf
```

路径：`重写 → 引用 → 资源路径` 粘贴上址 → 右上角更新。

### 脚本本体

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/WeRead_DailyBonus.js
```

### 定时任务

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/WeRead_DailyBonus.task
```

或手动：

```text
10 8 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/WeRead_DailyBonus.js, tag=微信读书签到, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Calendar.png, enabled=true
```

### 挂载后操作

1. QX：重写 → 引用上述 conf → **右上角强制更新**；开启 MitM 并信任证书
2. hostname 仅：`weread.qq.com`, `i.weread.qq.com`（勿整域 `*.qq.com`）
3. 打开微信读书 App（**首页即可**，启动接口自动抓凭证；无需进会员日页）
4. 通知「凭证已保存」后，手动运行「微信读书签到」任务验证
5. skey 失效时脚本自动重放 login 续期并写回（`WeRead_LoginBody` 存 login body）
6. 多账号按 vid 去重保存在 `WeRead_Cookies`；勿分享 vid/skey/login body
7. 同 conf 也覆盖 `flip-card-game/api` 路径抓翻一翻页 Cookie 凭证（翻一翻页仅用 Cookie 认证）

更新说明（2026-08-25 / capture-v1.3）：
- 双源凭证：header 携带 `vid`+`skey`（启动接口）+ Cookie 携带 `wr_vid`+`wr_skey`（翻一翻页）
- 白名单新增 `weread.qq.com/flip-card-game/api/`，打开翻一翻页即更新凭证
- GetCookie 合并两源去重写入 `WeRead_Cookies`，翻一翻脚本可直接复用

---

## 微信读书 翻一翻（每周二）

更新说明（2026-08-25 / capture-v1.1）：
- 每周二 8:00 刷新 6 次翻卡次数，定时任务每周二 8:10 跑
- API 明文 GET，明文路径：
  - 翻牌：`https://weread.qq.com/flip-card-game/api/flipCardFlip?cardIndex=N&giftIndex=N&pf=ios&platform=ios_html`
  - 接收：`https://weread.qq.com/flip-card-game/api/flipCardReceive?cardIndex=N&giftIndex=N&pf=ios&platform=ios_html`
- 认证：仅 Cookie（`wr_skey=...; wr_vid=...`），无独立 `vid`/`skey` header —— 需 capture-v1.3+ 的 conf 才能从翻一翻页抓到凭证
- 翻牌循环：cardIndex 1~6 + giftIndex 0~5；响应 `remainingCount` 驱动循环终止
- 接收：对 `status != 3 && autoReceive != 1` 的卡调 `flipCardReceive` 领取
- 奖励类型：`infinite`（1 天体验卡）/ `book`（赠书）/ `coin`（翻币）；状态 `status: 0=未领 3=已领 autoReceive=1=自动领`
- **复用 `WeRead_Cookies` / `WeRead_LoginBody`**（同 conf 同 prefs），无独立 capture 脚本
- capture-v1.1 诊断增强：空响应分三类提示 —「凭证过期(Cookie 失效)」/「本期额度已用完(remainingCount≤0)」/「本期无卡可翻」；成功通知附带真实 `remainingCount`，便于定位根因

### 脚本本体

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/WeRead_FlipCard.js
```

### 定时任务

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/WeRead_FlipCard.task
```

或手动：

```text
10 8 * * 2 https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/WeRead_FlipCard.js, tag=微信读书翻一翻, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Card.png, enabled=true
```

### 挂载后操作

1. 复用微信读书签到的 conf（capture-v1.3+ 已含 `flip-card-game/api`），无需额外 rewrite
2. 打开微信读书 App → **「翻一翻」** 页面（Cookie 凭证抓取 + 卡片状态可视化）
3. 通知「凭证已保存」后即跑定时任务（每周二 8:10 自动）
4. skey 失效：复用签到脚本的 `WeRead_LoginBody` 整套重放 login 续期

---

## 微信读书 我的阅读奖励（每周三、周五）

更新说明（2026-08-25 / capture-v1.0）：
- 端点：`POST https://i.weread.qq.com/weekly/exchange`，认证用 header `vid`+`skey`（与每日签到同源，复用 `WeRead_Cookies`）
- 查询(只读)返回三类奖励：`readtimeAwards`(按阅读时长) / `readdayAwards`(按阅读天数) / `readgoalAwards`(阅读目标)
  - `awardStatus`: 0=未达标 1=可领(领取) 2=已领取
  - `awardChoices`: `choiceType=1` 体验卡(awardNum=天) / `choiceType=2` 书币(awardNum=枚)
- 领取规则（用户确认）：书币 `awardNum >= 2` 领书币(choiceType2)，否则领体验卡(choiceType1)
- 定时：每周三、周五 8:10（`10 8 * * 3,5`）；仅领 `awardStatus==1` 项，已领(状态2)自动跳过，幂等
- `memberCardExchange`（付费会员卡兑换，用体验卡换 30 天会员）非免费奖励，脚本跳过
- 复用 `WeRead_Cookies` / `WeRead_LoginBody`（同 conf 同 prefs），无需额外 conf

### 脚本本体

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/WeRead_WeeklyReward.js
```

### 定时任务

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/WeRead_WeeklyReward.task
```

或手动：

```text
10 8 * * 3,5 https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/WeRead_WeeklyReward.js, tag=微信读书我的阅读, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Card.png, enabled=true
```

### 挂载后操作

1. 复用微信读书签名的 conf（capture-v1.3+，打开 App 首页即抓 header 凭证），无需额外 rewrite
2. 挂上 `WeRead_WeeklyReward.task`（每周三、周五 8:10 自动）
3. 脚本只领当前可领项（awardStatus==1），已领自动跳过；阅读时长/天数未达标则当周无奖励
4. skey 失效：复用 `WeRead_LoginBody` 整套重放 login 续期

---

## 泰康在线（微信小程序）每日领金币

更新说明（2026-08-30 / capture-v1.0）：

- 入口：微信小程序「泰康在线」`wx9e3e7020c4a10356`（page 395）
- 4 个奖励动作（全 POST，响应明文 JSON）：
  - 登录签到 5 金币 → `POST /activity_execute/rest/membergoldbean/sign`
  - 每日打卡 1000 步 15 金币 → `POST /promotion/activity_execute/rest/springOuting/draw`（`drawSource=dailyOneK`）
  - 每日打卡 5000 步 30 金币 → `POST /promotion/activity_execute/rest/springOuting/draw`（`drawSource=dailyFiveK`）
  - 每日打卡 10000 步 50 金币 → `POST /promotion/activity_execute/rest/springOuting/draw`（`drawSource=dailyTenK`）
- **路线 B frozen payload 重放**：所有请求体走 `{"enc":true,"encData":"<hex>"}` 包装，密钥嵌在微信小程序 JS 内、无法从抓包还原。脚本内已固化 4 个 encData + Authorization + Signature，无需 MitM
- draw 系列额外带 `Authorization`（会话级，长效）和 `Signature`（per-request 绑定 body）。直接重放 body+headers 原样即可

### 推荐（QX 任务资源）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/Taikang_DailyBonus.task
```

### 脚本本体

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/Taikang_DailyBonus.js
```

### 定时任务

```text
0 9 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/Taikang_DailyBonus.js, tag=泰康在线领金币, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Coin.png, enabled=true
```

### 挂载后操作

1. QX：任务 → 引用上述 task → **强制更新**；无需 MitM / 证书
2. 直接运行任务（4 段奖励一次性领取），通知展示三类状态：✅ 领取成功 / ☑️ 今日已完成 / ❌ 失败
3. **frozen payload 失效处理**：当 4 项全部失败（业务错误 `error_code≠0` 或网络错误）：
   - 重新打开微信小程序「泰康在线」→ 进入「每日签到福利」页
   - 用抓包工具（Stream / httpcanary）抓 4 个对应接口（`sign` + 3 个 `draw`）
   - 替换脚本 `Payloads` 数组中对应 `body` / `headers`（`Authorization` 仅一项，`Signature` 每条不同）
   - 4 段 encData 整体替换后 commit & push
4. 每日 09:00 定时跑，账户余额变化以小程序为准

### 凭证有效期（2026-08-30 由 JWT 解码得出）

| Token | exp（UTC+8） | 距抓包 |
|-------|-------------|--------|
| `accessToken` | 2026-09-06 15:32:59 | 7.00 天 |
| `refreshToken` | 2026-09-29 15:32:59 | 30.00 天 |

**结论**：frozen payload 预计可用到 **2026-09-06** 前后，建议在到期前一周内重新抓包一次。

### 已知业务码

| error_code | 文案 | 处理 |
|-----------|------|------|
| `0` | 接口成功执行 | ✅ 成功 |
| `200004200003` | 今日已签到! | ✅ 视为成功（已在 `DONE_CODES`） |
| `200001000001` | 网络有点拥挤，请稍后重试 | **打卡接口 Signature 校验失败（非「已领取」）**，见下 |

### 排障决策树

- **签到成功 / 今日已签 + 打卡 3 项全报 200001000001**：这是**最典型现象**，已定性。
  比对手动打卡成功请求可知：`Authorization` 与 `encData` 均与脚本 frozen 值完全一致，
  唯独 `Signature` 后 48 字节每次请求都不同（前 48 字节固定）。说明 draw 接口的
  Signature 绑定一个**未在请求中传输**的时间戳/随机数，服务端做新鲜度校验，
  frozen Signature 必失效。**此乃结构性限制，frozen payload 无法自动化 3 个打卡**，
  ⚠️ 切勿把 200001000001 补进 `DONE_CODES`（会掩盖真实失败）。
  想真正自动化打卡，须逆向小程序签名算法（见下「进阶」），或保持「签到自动 + 打卡手动」。
- **4 项同时失败且签到也报鉴权/无效类错误**：payload 已过期 → 重新抓包替换 `Payloads`
- **打卡成功但余额不变**：服务端防重放（接受请求但不入账）→ 需日更抓包

---

## 合规说明

本仓库仅托管**自建签到 / 抓包缓存凭证 / 定时任务**类配置。  
**不提供**会员 SVIP / 倍速 / 清晰度解锁等破解脚本。

### 定时未自动签到 / 必须进页才有包（capture-v8.2）

原因：
- 真正的签到写请求往往只在「打开签到页 / 点击签到」时发出
- 定时任务若本地无 `BYD_Cookie`，只能报无凭证
- 仅 `switches/getUnionResource` 不能当签到

v8.2：
1. 抓到 `com.app.dynasty.srv` 时 **自动暂存** 为凭证（`AutoPromoteMina=true`）
2. 定时任务若无凭证，会再从 mina 环形缓冲提升一次
3. 仍建议：每天首次打开签到页（或点签到）后，再跑任务更稳

注意：
- 自动暂存的可能是「进页查询包」而非「写签到包」
- 若回放 HTTP 200 但积分不变：说明防重放/包类型不对，仍需在「真实点签」瞬间对照积分
- 完全无人值守是否可行，取决于服务端是否允许重复回放；当前只能最大化自动化抓取与回放链路

### 打开 App 触发签到（capture-v9，推荐主模式）

目标从「定时回放」改为「打开比亚迪 App 时触发一次签到」。

行为：
1. MitM 命中 `mina.byd.com .../mgw.htm`
2. 抓到 `com.app.dynasty.srv`（`src=bodyBytes`）→ 自动暂存凭证
3. **同步启动回放**（`$done` 前发起 `$task.fetch`，v9.2 起）
4. 默认同日完成后不再刷（`OpenAppSignOncePerDay`）+ 120s 去抖

使用：
1. 只挂 **rewrite**，任务 cron 可关
2. 打开主 App → 最好再进「每日签到」页（更容易出 dynasty.srv）
3. 看通知「比亚迪打开App签到」与日志 `[BYD openSign]`
4. 以积分是否变化为准

注意：
- v9 早期：仅首页 `switches` 不会触发；**v9.1+** 已用 switches 作启动信号 + 缓存回放
- 回放的是抓到的最新 dynasty 包；若只是进页查询包，可能 HTTP 200 但积分不变
- 同日重试：临时 `DeleteCookie=true` 清日标，或清 `BYD_OpenAppSignDate`

### 只打开 App、不进签到页（capture-v9.1）

约束（业务侧）：
- 进入签到页时，**App 自己就会自动签到**
- 用户目标：打开 App 首页即可完成脚本侧签到，**不必点进签到页**

脚本策略：
1. **启动信号**：首页 `switches` / `afterloginPb` / `getUnionResource` 等 mina 包
2. **签到载荷**：回放本地缓存的 `dynasty.srv`（`BYD_MinaSign` / `BYD_Cookie`），**不是** switches 的 body
3. **首次建仓**：仍需「一次性」进入签到页（App 自签即可），脚本缓存 bodyBytes
4. **之后日常**：只开 App → 检测到首页信号 → 异步回放缓存包（同日一次）
5. 缓存失效（连续失败/无积分）：再进一次签到页刷新凭证

无法绕过的边界：
- 不进签到页就永远没有首次 body 可缓存
- 纯缓存回放可能被服务端 Ts/Sign/防重放拒绝；失败后需重新进页刷新
- 脚本不能替用户“点开”签到页；只能在 MitM 看得到首页流量时动手




### 最终结论：缓存回放不可行，v9.3 转为检测确认模式

**铁证（QX 抓包）**：脚本回放 mina 请求时，服务端返回

```
HTTP/1.1 200 OK
Content-Length: 0
Result-Status: 7003
Memo: 验签时间戳校验失败
Tips: 手机时间异常，请到系统时间设置，将其设为最新。
```

**根因**：`mina.byd.com` mPaaS 网关校验请求头 `Ts`（编码时间戳）与 `Sign`（由 body+时间戳+密钥计算）。缓存包的时间戳过期后必然被拒（HTTP 200 空 body）。签到 body 为客户端加密且含时间戳，无法离线重生成。

**结论：「打开 App 不进签到页即签到」在 Quantumult X 层面不可实现。**

v9.3 策略调整：
1. 检测到 `dynasty.srv`（= 进入签到页）→ App 自签 → 脚本确认 + 通知「签到已完成」+ 记当日完成
2. 打开 App 首页且今日未签 → 低频提醒（3 小时最多一次）进页签
3. 手动跑脚本 → 明确报告 7003 时间戳校验失败（不再显示模糊的 respLen=0）
4. 保留凭证缓存与回放代码供诊断

**真正的一键签到替代方案**：iOS 快捷指令 —— 打开比亚迪 App 并跳转签到页（App 进页即自动签到）。可在快捷指令中用 App 的 URL scheme 或「打开 App」+ 辅助触控路径实现，配合自动化定时触发。

\n### 打开 App 即 fire（capture-v9.2，修 pending 不 fire）

问题：v9.1 日志只有 `[BYD openSign] pending`，没有 `fire/result`。  
根因：QX `script-request` 在 `$done({})` 后常终止脚本上下文，`setTimeout(1.2s)` 的 `attemptFire` 不会执行。

v9.2 改动：
1. 收到首页启动信号后，**同步** `resolve` 缓存 `dynasty` 凭证并 `fire`
2. **在 `$done` 之前**调用 `$task.fetch`（`BYDSignIn(s=0)` 立即发包）
3. 取消依赖 done 后的长 `setTimeout` 回放
4. 旧 MarkMinaAsSign 提示改为低频建仓提示（AutoPromote 为主）

验收日志应依次出现：
- `[BYD mina] ... switches...` 或 `dynasty.srv`
- `[BYD openSign] pending mode=home|capture`
- `[BYD openSign] fire mode=... hasB64=1`
- `[BYD] mina 回放: ...`
- `[BYD openSign] request-done via=fire-started`
- （尽量）`[BYD openSign] result: ...` 与通知「比亚迪打开App签到」

使用：
1. 重写资源 **强制更新** 到 v9.2
2. 若本机尚无凭证：一次性进「我的 → 每日签到」建仓（看 `autoPromote hasB64=1`）
3. 杀进程后只开 App 到首页，不必再进签到页
4. 若同日已尝试过：清 BoxJs/`BYD_OpenAppSignDate` 或等次日；也可短时关 `OpenAppSignOncePerDay` 测

仍存在的业务边界：
- 缓存包可能被防重放拒绝（HTTP 200 但积分不变）→ 再进签到页刷新 dynasty
- 服务端积分以 App 为准；mina 响应常为二进制，脚本只能给「已送达」级判定
