# Quantumult X 挂载地址

仓库：https://github.com/kugooer/myconfig

---

## 一、中国移动签到

更新说明（2026-08-13 / 双任务拆分）：
- App 主路径：`qwhdsso SSO → QWHD_SESSION_TOKEN → /mark31/domark`
- 云盘主路径：缓存 jwt → `startSignIn`（打开云盘即可；首次请进签到页让 App 生成 jwt）
- **定时任务拆成两条**：`argument=app` / `argument=cloud`，互不影响

### 推荐（QX 重写资源）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/CMCC_DailyBonus.conf
```

路径：`重写 → 引用 → 资源路径` 粘贴上址 → 右上角更新。

### 脚本本体

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/CMCC_DailyBonus.js
```

### 定时任务（拆成 2 个，推荐）

**方式 A：任务资源一次引入两条**

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/CMCC_DailyBonus.task
```

**方式 B：手动各加一条**

```text
10 8 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/CMCC_DailyBonus.js, tag=移动App签到领奖, argument=app, enabled=true
20 8 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/CMCC_DailyBonus.js, tag=移动云盘签到, argument=cloud, enabled=true
```

说明：
- `argument=app`：只跑签到领奖（domark）
- `argument=cloud`：只跑移动云盘（startSignIn）
- 不写 argument 或 `argument=all`：兼容旧行为，两个都跑
- 若仍保留旧的「移动即时签到」单任务，请删掉，避免同一天跑两次

### 挂载后操作

1. 开启 MITM，并信任证书（hostname 见 rewrite conf，勿自扩 `*.yun.139.com`）
2. 打开中国移动 App **登录/切号**，等会话更新
3. **首次**点开 App「签到领奖」页（缓存 QWHD_SESSION_TOKEN / SSO 能力）
4. **首次**打开移动云盘 → 进一次「签到」页，让脚本缓存 jwt（控制台有 `cloud jwt cached ... len=xxx`）
5. 之后：
   - 定时：App 任务 / 云盘任务各跑各的
   - 打开云盘 App：有 jwt 且当日未签时自动 startSignIn 一次
6. 若历史串号：清空 `CookiesCMCC` 与 `CMCC_SignEndpoints` 后重登

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

更新说明（2026-08-14 / capture-v1.1-quiet-capture）：

- 抓包定位：`app.jegotrip.com.cn` 任务中心 H5
- `querySign`（明文）→ 选下一天 `signConfigId`（`isSign=2` 中 `completeNumber` 最小）
- `userSign`：明文 `{"signConfigId":id}`，AES-ECB 包装为 `{sec,body}`
- 密钥：`online_jego_h5` / `93EFE107DDE6DE51`（missioncenter 前端）
- 抓包对照：两账号分别到账 **+8**、**+6** 无忧币（`getUserTripCoins` 记录「签到」）
- **v1.1**：用户验收双账号「今日已签」正确；抓包路径不再打印「签到用时」；普通 cookie update 静默

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
2. hostname 仅：`app.jegotrip.com.cn`, `app3.jegotrip.com.cn`（勿整域 `*.jegotrip.com.cn`）  
3. 打开无忧行 → **任务中心/签到页**（每个要签的账号各进一次）  
4. 通知「凭证新增/已保存」后，手动运行「无忧行签到」任务验证  
5. 多账号按 token 去重保存在 `JegoTrip_Cookies`  
6. token 过期会提示重新进签到页；勿分享 token

---

## 四、银河证券 App 签到

更新说明（2026-08-17 / capture-v1.1）：
- 抓包定位：H5 网关 `mall.chinastock.com.cn/h5_gateway/smart-trade/vip/*`
- 凭证：请求头 `Cookie: SESSION=...`（进入「智能VIP/VIP中心」H5 页面时携带）
- 签到接口：`POST /h5_gateway/smart-trade/vip/checkIn`，body `{}`
  - 响应 `{"ret":{"error":"0","msg":"操作成功"},"data":1}` → 签到成功
- **主模式**：打开 App 进入「智能VIP/VIP中心」页 → 命中即自动签到并通知
  （v1.0 曾用 setTimeout 延迟 1~3s，QX 会杀定时器导致不回放；v1.1 改为命中即同步 fire）
- 并发去抖：`GS_OpenSignLock` 120s；同日一次：`GS_AutoDate`
- 定时任务（9:30）作为兜底，错过打开 App 时补签

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
3. 打开银河证券 App → 任意页面（H5 会自动请求 vip 接口），看通知「SESSION 凭证已更新」
4. 之后每次打开 App，延时 1~3 秒自动签到并通知「今天签到完成…」
5. SESSION 失效（重登/过期）会提示，重新打开 App 即可刷新
6. 奖励文案默认「智能VIP 1天特权 / VIP到期日 2027-09-19」，可在脚本顶部 `RewardTip` 修改

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
