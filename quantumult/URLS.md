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

### 挂载后操作（capture-v5）

1. 开启 MITM，信任证书；**重写资源右上角强制更新**
2. hostname 应含：`dilinkappserver-cn.byd.auto`、`dilinkappserver.byd.auto`、`mina.byd.com`  
   **不要**加 车况 super 域名（无效）
3. **彻底杀掉比亚迪进程**后打开主 App（不是桌面小组件）
4. 我的 → **每日签到 / 积分商城 / 福利**，点一次签到
5. 成功通知：`比亚迪签到凭证新增/更新成功`，日志 `signLike=1` 且 URL 含 `club`/`Sign.signIn`
6. 再手动运行定时任务；凭证失效后重复第 4 步

若打开签到页「没有任何反应」且日志无新的 `[BYD capture]`（诊断时间戳仍是旧车况）：
- rewrite/MitM 未命中主 App 流量，或 dilink 证书固定导致看不到包
- 请更新 v5 后重进签到页，把**最新**日志发我

---

## 合规说明

本仓库仅托管**自建签到 / 抓包缓存凭证 / 定时任务**类配置。  
**不提供**百度网盘等会员 SVIP / 倍速 / 清晰度解锁脚本。


### 未获取到签到凭证（排障）

报错 `未获取到签到凭证` 表示定时任务正常，但 **还没有成功抓到 `request`**。

按顺序确认：
1. 更新并启用重写：`quantumult/rewrite/BYD_DailyBonus.conf`（右上角强制更新）
2. QX：`MitM → HTTPS 解密` 开启，已安装/信任证书
3. hostname 含：
   - `dilinkappserver-cn.byd.auto`
   - `dilinkappserver.byd.auto`
   - `mina.byd.com`（诊断用）
4. 清空旧脏凭证：`BYD_Cookie` / `BYD_Cookies` / `BYD_CaptureDiag`（或 `DeleteCookie=true` 跑一次）
5. 主 App → **我的 → 每日签到**，点一次签到（不是小组件刷新）
6. 成功通知：`比亚迪签到凭证新增/更新成功`
7. 再手动运行任务验证

若仍失败：查看 QX 日志中的 `[BYD capture]`：
- 时间戳仍是旧的车况 `vehicleRealTime`：主 App 签到流量没进来
- 出现 `host=mina.byd.com`：主 App 网关可达，继续进签到页找 `dilinkappserver`
- 出现 `host=dilinkappserver... /club/` 且 `signLike=1`：应已入库
- 出现「未确认签到 URL」通知：把完整 URL 发我放宽规则
- `signLike=1` 但「无 request」：把该 URL 发我继续适配


### 分流直连（推荐，防网络错误）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/filter_byd_direct.snippet
```

### 挂载后 App 提示「网络错误」

原因通常是 **MITM 范围过大** 或 **脚本拦截了非签到接口**，App 证书校验/关键链路失败。

处理：
1. 更新 rewrite 到最新 capture-v5（不 MitM 车况 super 域）
2. 关闭地图/埋点等无关 MITM；`mina.byd.com` 仅用于诊断，若导致异常可临时去掉
3. 策略里把 `*.byd.auto`、`*.bydauto.com.cn` 设为 **DIRECT**（仍可对 rewrite 命中域名解密）
4. 若仍报网络错误：先禁用该重写资源，确认 App 恢复，再只启用最新 conf
5. 抓凭证时：保持 rewrite 开启 → 进入签到页点一次 → 出现「凭证成功」通知后，可临时关闭 rewrite 只留定时任务



### 日志只有 mina.byd.com + op=com.app.dynasty.srv（capture-v6）

说明：主 App 已进入 **王朝 mPaaS 网关**，旧 `dilinkappserver/club/Sign.signIn` 路径可能已不再触发。

1. 强制更新 rewrite 到 capture-v6（mina 使用 **script-request-body**，不要 header-only）
2. 打开主 App → **我的 → 每日签到/签到抽盲盒**，点一次签到
3. 日志应出现 `[BYD mina]`，关注 `op=`、`bodyLen`、`signLike`、`bodyHint`
4. 若弹出「比亚迪 mina 签到线索」：把通知全文发我，继续做回放
5. 若 bodyLen 仍为 0：确认资源已更新为 body 规则

### 日志里大量 vehicleRealTime / getStatusNow 且 signLike=0

这些是**车况/小组件接口**，`request` 字段不能用于积分签到。

正确姿势：
1. 更新 rewrite 到最新（已排除车况 super 域名）
2. 打开 App → **我的/积分/签到/福利** 页，点一次「签到」
3. 日志应出现 URL 含 `club` 或 `Sign.signIn`，且 `signLike=1`
4. 再运行定时任务


### mina body 已加密且 op 固定（capture-v7）

现状（你日志已确认）：
- `bodyLen>0`：body 抓包成功
- `op=com.app.dynasty.srv` 固定 + `bodyHint` 乱码：网关内业务名不可见，属 mPaaS 正常现象
- 无法仅靠关键字自动判定“哪一条是签到”

操作：
1. 强制更新到 capture-v7
2. 打开 App → 我的 → 每日签到 → **点一次签到**
3. 立刻运行任务：本地脚本设 `MarkMinaAsSign = true`（只跑这一次）
4. 看到「已标记最近 mina 请求为签到凭证」后，把 `MarkMinaAsSign` **改回 false**
5. 再手动运行任务做回放验证
6. 把签到成功/失败通知与响应原文发我（若失败，继续适配）

说明：mPaaS 请求常含时间戳/签名，**原样回放可能失败**；但先验证回放能否被服务端接受是必须一步。

### mina 回放「响应非 JSON」/ 需二进制回放（capture-v8）

现象（v7 已验证）：
- `MarkMinaAsSign` 可标记成功，`bodyLen` 正常
- 回放提示「响应非 JSON」：mina/mPaaS 返回常是**二进制**，不能按 JSON 判失败
- 若 body hex 里大量 `fd`：说明 body 曾被当作 UTF-8 字符串损坏

v8 改动：
1. 抓包优先 `bodyBytes` → base64（`bodyB64`）持久化
2. 回放用 `bodyBytes`，避免 string 损坏
3. 响应输出 `http` / `respHex` / `respLen`，并写入 `BYD_LastReplay`
4. 标记时优先 `com.app.dynasty.srv`，自动跳过 `switches` 类 RPC

操作：
1. **重写资源强制更新**到 capture-v8
2. （建议）任务里 `DeleteCookie=true` 跑一次清旧凭证，再改回 false  
   或至少清空 `BYD_Cookie` / `BYD_Cookies` / `BYD_MinaSign` / `BYD_MinaLast` / `BYD_MinaRing`
3. 彻底杀掉比亚迪 App → 重新打开 → **我的 → 每日签到 → 点一次签到**
4. 日志应出现：`[BYD mina] ... bodyLen=... src=bodyBytes`（`src=text` 也能用，但 bodyBytes 更稳）
5. 本地脚本设 `MarkMinaAsSign = true` 跑一次 → 通知含 **`hasB64: 1`**
6. **立刻改回** `MarkMinaAsSign = false`
7. 再手动运行任务回放
8. 把通知/日志里的 **`http` / `respHex` / `hasB64` / `BYD_LastReplay`** 发我

结果解读：
- `hasB64: 0`：本机 QX 未给出 bodyBytes，只能用 text 路径；把完整 [BYD mina] 日志发我
- `mina回放已送达(HTTP 2xx)` + 二进制：请求已被服务端接受形态，**请对照 App 积分是否变化**；是否真正签到成功需结合积分/二次点签到验证
- `HTTP 4xx/5xx` 或 respLen=0：可能是签名/时效/防重放，继续发元数据做判定

说明：mPaaS 常含时间戳与网关签名，**不能保证长期纯回放稳定**；v8 先解决“二进制损坏 + 误判非 JSON”这两个确定问题。

### 进签到页可标记但「今天点不了签到」（capture-v8.1）

若当天已签过，只能进入签到页：

1. v8 已验证：`src=bodyBytes`、`hasB64=1`、回放 `HTTP 200` + 二进制响应 —— **链路技术可行**
2. 但「仅进页」产生的 `com.app.dynasty.srv` 更可能是查询/状态包，**不是签到写操作**
3. v8.1 标记策略改为优先 **最新** `dynasty.srv`（不再按 body 最大）
4. **请明天真实可点签到时**：点签到 → 立刻 `MarkMinaAsSign=true` → 改回 false → 回放  
   并对照 **积分是否变化 / 是否提示已签到**
5. 把新一次标记通知中的 `capturedAt` / `bodyLen` / `hex` 与回放 `http/respHex` 发我

说明：若服务端对同一 payload 防重放，则「首次点签到成功 + 脚本二次回放失败」仍可能出现；那时需评估是否有可复用的日更凭证，而不是无限原样回放。

