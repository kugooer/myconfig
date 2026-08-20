# 中国移动 / 移动云盘签到 · Quantumult X 挂载地址

仓库：https://github.com/kugooer/myconfig

更新说明（2026-08-20 · **重写 + 任务彻底拆分**）：
- **根因**：旧合并 rewrite 同时挂 App 与云盘；登录中国移动时若云盘后台有 `getUser`，日志会夹杂云盘签到
- **现方案**：App / 云盘各一套 rewrite + task；脚本仍共用 `CMCC_DailyBonus.js`（`argument=app|cloud`）
- 旧 `CMCC_DailyBonus.conf` / `.task` 已改为空壳弃用，更新后会清掉合并规则

## ① 中国移动 App · 签到领奖

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

## ② 移动云盘签到

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

## 脚本本体（共用）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/CMCC_DailyBonus.js
```

## QX 迁移步骤（重要）

1. **删除或停用** 旧资源：`CMCC_DailyBonus.conf`、旧合并 task「移动即时签到 / CMCC_DailyBonus.task」
2. **新增** 上面①② 两套 rewrite（可只开 App、只开云盘，或都开）
3. **新增** 两套 task（或只加你需要的那一套）
4. 重写资源 → 右上角更新；MITM 按各 conf 的 hostname（勿自扩 `*.yun.139.com`）
5. App：登录中国移动 → 看 `mode app`，**不应再出现** `cloud open sign start`
6. 云盘：首次进一次「签到」页缓存 jwt；之后打开云盘或定时 `argument=cloud`

## 行为对照

| 资源 | 触发 | 是否跑云盘 |
|------|------|------------|
| App rewrite + 登录 | fingerprintLogin → domark | 否 |
| App 定时 `argument=app` | cron | 否 |
| 云盘 rewrite + 打开云盘 | getUser / tyrz / startSignIn | 是 |
| 云盘定时 `argument=cloud` | cron | 是 |

## 挂载后操作

1. App：登录/切号；建议首次打开「签到领奖」页
2. 云盘：首次进「签到」页，控制台出现 `cloud jwt cached ...`
3. jwt 失效后需再进一次签到页刷新（脚本会提示并清空旧 jwt）
4. 历史串号：清空 `CookiesCMCC` 与 `CMCC_SignEndpoints` 后重登
