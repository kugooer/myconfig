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

更新说明（2026-08-14 / capture-v1-token+AES-userSign）：

- 抓包定位：`app.jegotrip.com.cn` 任务中心 H5
- `querySign`（明文）→ 选下一天 `signConfigId`（`isSign=2` 中 `completeNumber` 最小）
- `userSign`：明文 `{"signConfigId":id}`，AES-ECB 包装为 `{sec,body}`
- 密钥：`online_jego_h5` / `93EFE107DDE6DE51`（missioncenter 前端）
- 抓包对照：两账号分别到账 **+8**、**+6** 无忧币（`getUserTripCoins` 记录「签到」）

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
