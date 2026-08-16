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
3. **异步回放签到**（先 `$done` 放行 App 原请求，不拖慢 App）
4. 默认同日完成后不再刷（`OpenAppSignOncePerDay`）+ 120s 去抖

使用：
1. 只挂 **rewrite**，任务 cron 可关
2. 打开主 App → 最好再进「每日签到」页（更容易出 dynasty.srv）
3. 看通知「比亚迪打开App签到」与日志 `[BYD openSign]`
4. 以积分是否变化为准

注意：
- 仅首页 `switches` 不会触发签到
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

