# air724ug-forwarder

Air724UG（RDA8910）来电智能接听录制 + 短信转发脚本，基于 LuatOS-Air。

## 上游来源

- 仓库：https://github.com/flying1008/air724ug-forwarder
- 提交：88df775101ccfabecb7ada0c9c348bfd62ad7a05（使用 websocket 内置的重连方式）
- 原作者仓库（0wQ/air724ug-forwarder）已被作者清空，以 flying1008 的 fork 为准

## 目录说明

- `script/` — Lua 脚本（main.lua、handler_call.lua、handler_sms.lua 等）
- `core/LuatOS-Air_V4029_RDA8910_RFTIPMSTSVT_0x70000.pac` — 底层固件

## 配置

编辑 `script/config.lua`，按需填写通知渠道（Bark / 钉钉 / Telegram 等）、白名单号码、录音上传地址等。详见脚本内注释。

## 刷入

使用 LuaTools v3 下载脚本到 Air724UG 模块：https://luatos.com/luatools/download

> 本目录为上游原版导出，不含任何个人配置信息。
