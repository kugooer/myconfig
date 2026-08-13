# 中国移动签到 · Quantumult X 挂载地址

仓库：https://github.com/kugooer/myconfig

更新说明（2026-08-13 抓包）：
- 主路径改为 **qwhdsso SSO → QWHD_SESSION_TOKEN → `/mark31/domark`**
- 签到 body 动态为 `{"date":"yyyyMMdd"}`，不回放历史报文
- 无 H5 会话时不再盲打 mark API（避免 302→404）

## 推荐（QX 重写资源）

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/rewrite/CMCC_DailyBonus.conf
```

路径：`重写 → 引用 → 资源路径` 粘贴上址 → 右上角更新。

## 脚本本体

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/CMCC_DailyBonus.js
```

## 定时任务

```text
10 8 * * * https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/scripts/CMCC_DailyBonus.js, tag=移动即时签到, enabled=true
```

或引用：

```text
https://raw.githubusercontent.com/kugooer/myconfig/main/quantumult/task/CMCC_DailyBonus.task
```

## 挂载后操作

1. 开启 MITM，并信任证书；hostname 含 `*.10086.cn`
2. 打开中国移动 App **登录/切号**，等「登录会话已更新」
3. **建议再点开一次「签到领奖」页**（首次），让脚本捕获 `QWHD_SESSION_TOKEN`；之后登录即可自动 SSO+domark
4. 若历史误学导致串号：清空 BoxJS/Prefs 中 `CookiesCMCC` 与 `CMCC_SignEndpoints` 后重登
