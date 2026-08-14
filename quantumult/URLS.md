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

### 挂载后操作

1. 开启 MITM，信任证书
2. 确认 hostname **仅**：`dilinkappserver-cn.byd.auto`、`dilinkappserver.byd.auto`（**不要**加 `dilinksuperappserver`，那是车况/控件域）
3. 打开 **比亚迪 App**，保持登录
4. 进入 **积分商城/签到/福利**（必要时手动点一次签到），直到通知「凭证新增/更新成功」，且日志 `signLike=1`、URL 含 `club`/`Sign.signIn`
5. 之后由定时任务每日自动签到；凭证失效后重复第 4 步

---

## 合规说明

本仓库仅托管**自建签到 / 抓包缓存凭证 / 定时任务**类配置。  
**不提供**百度网盘等会员 SVIP / 倍速 / 清晰度解锁脚本。


### 未获取到签到凭证（排障）

报错 `未获取到签到凭证` 表示定时任务正常，但 **还没有成功抓到 `request`**。

按顺序确认：
1. 更新并启用重写：`quantumult/rewrite/BYD_DailyBonus.conf`（右上角强制更新）
2. QX：`MitM → HTTPS 解密` 开启，已安装/信任证书
3. hostname 仅：
   - `dilinkappserver-cn.byd.auto`
   - `dilinkappserver.byd.auto`
4. 若本地曾保存车况凭证：清空 `BYD_Cookie` / `BYD_Cookies`（或在脚本临时设 `DeleteCookie=true` 跑一次）
5. 不要只跑定时任务：必须先打开比亚迪 App → **积分商城/签到**，必要时**点一次签到**
6. 成功通知：`比亚迪签到凭证新增/更新成功`（内容应显示 url 含 Sign/club）
7. 再手动运行任务验证

若仍失败：查看 QX 日志中的 `[BYD capture]`：
- `signLike=0` 且 URL 含 `vehicleRealTime`/`getStatusNow`/`query_configs`：这是车况，**忽略**；请进签到页再点一次
- 无任何 `[BYD capture]`：rewrite/MitM 未命中 `dilinkappserver`
- `signLike=1` 但「无 request」：把该 URL 发我继续适配


### 分流直连（推荐，防网络错误）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/filter_byd_direct.snippet
```

### 挂载后 App 提示「网络错误」

原因通常是 **MITM 范围过大** 或 **脚本拦截了非签到接口**，App 证书校验/关键链路失败。

处理：
1. 更新 rewrite 到最新（已收窄为仅 `Sign.signIn` / `integralMall` / `club` 签到相关）
2. 关闭对 `mina.byd.com`、地图、埋点域名的 MITM
3. 策略里把 `*.byd.auto`、`*.bydauto.com.cn` 设为 **DIRECT**（仍可对 rewrite 命中域名解密）
4. 若仍报网络错误：先禁用该重写资源，确认 App 恢复，再只启用最新 conf
5. 抓凭证时：保持 rewrite 开启 → 进入签到页点一次 → 出现「凭证成功」通知后，可临时关闭 rewrite 只留定时任务


### 日志里大量 vehicleRealTime / getStatusNow 且 signLike=0

这些是**车况/小组件接口**，`request` 字段不能用于积分签到。

正确姿势：
1. 更新 rewrite 到最新（已排除 `dilinksuperappserver`）
2. 打开 App → **我的/积分/签到/福利** 页，点一次「签到」
3. 日志应出现 URL 含 `club` 或 `Sign.signIn`，且 `signLike=1`
4. 再运行定时任务
