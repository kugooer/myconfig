# 中国移动签到 · Quantumult X 挂载地址

仓库：https://github.com/kugooer/myconfig

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

1. 开启 MITM，并信任证书
2. 确认 hostname 含 `*.10086.cn`
3. 打开中国移动 App 登录/切号，等「登录会话已更新」
4. 次日未签前点一次「立即签到」完成接口学习
