# MyAPI Surge 签到模块

目标站：https://myapi.286600.xyz
改编来源：[MaYIHEI/paperclip `app/agentrouter`](https://github.com/MaYIHEI/paperclip/tree/main/app/agentrouter)（AgentRouter 签到，原作者 @773075692）

## 原理

MyAPI 是新版 New-API（v1.0.0-rc.36），登录和签到方式与 AgentRouter 的老版本**不一样**：

| 步骤 | 请求 |
|---|---|
| 查余额显示配置 | `GET /api/status` → `display_in_currency`、`quota_per_unit` |
| 登录 | `POST /api/user/login` `{"username","password"}` → `data: {access_token, user: {id, username, quota, …}}` |
| 之后所有请求带 | `Authorization: Bearer <access_token>` + `New-API-User: <user_id>` |
| 查余额 | `GET /api/user/self` → `quota`、`used_quota`、`request_count` |
| 查今日签到状态 | `GET /api/user/checkin?month=YYYY-MM` → `stats.checked_in_today`、`stats.records`（含 `checkin_date`、`quota_awarded`） |
| 签到 | `POST /api/user/checkin` → 成功返回 `data: {quota_awarded, checkin_date}`；今日已签过返回 `Already checked in today` |

关键区别：

- 新版登录**不再返回**顶层 `data.id` / `data.checked_in`，也不发 `session` Cookie，改发 Bearer `access_token`。v1 版本的脚本按老格式解析，才会报“登录响应缺少 Cookie 或用户编号”。
- 新版登录本身**不再自动签到**，必须显式调 `POST /api/user/checkin`。今天已签到过时，脚本先查状态确认，不重复 POST，直接显示今日奖励。

流程：登录 → 查余额 → 查今日签到状态 → 未签到则 POST 签到 → 再查一次余额（奖励已入账）。

本站 `/api/status` 已实测验证（2026-11-25）：

- `checkin_enabled: true` —— 确实有每日签到
- `display_in_currency: true`，`quota_per_unit: 500000` —— 余额按 `$ = 额度 / 500000` 显示，签到奖励（原始额度）同样换算
- `password_login_enabled: true` —— 账号密码登录可用
- `github_oauth: false`，`linuxdo_oauth: false` —— **没有 GitHub 登录**
- `turnstile_check: false` —— 签到接口不需要 Turnstile 票据
- 第三方登录只有 NODELOC，另有 Passkey —— 两者都需要浏览器交互，**无法在 Surge 定时任务里完成**

所以本模块只能用**账号密码**登录签到。如果你是在 MyAPI 上用 NODELOC 注册的账号、没有设置过密码，请先在网站「个人设置」里设置一个密码，再填到模块里。

## 文件

- `myapi.js` —— 签到脚本（Surge / Loon / Quantumult X / Stash 通用）
- `myapi.sgmodule` —— Surge 模块
- `README.md` —— 本文件

## 安装（Surge）

### 1. 托管脚本（已完成）

脚本已托管在本仓库，地址为：

`https://raw.githubusercontent.com/JiuYueQingCheng/myapi-surge-checkin/main/myapi.js`

`myapi.sgmodule` 里的 `script-path` 已指向该地址，直接导入模块即可，不用改。

如果你要 fork 或换仓库，相应地改 `myapi.sgmodule` 里 `script-path=` 的地址即可；也可以把 `myapi.js` 放到 Surge 能读到的本地路径，把 `script-path=` 改成该路径。

### 2. 填账号密码（模块编辑参数，不用改文件）

导入模块后，在 Surge 模块列表里点开「MyAPI签到」→ **编辑参数**，填：

- `username` —— MyAPI 的用户名或邮箱
- `password` —— 网站登录密码
- `checkin_hour` —— 每天签到的小时，0-23，默认 9
- `checkin_minute` —— 每天签到的分钟，0-59，默认 0

填好保存即可。模块会把它们拼成 `argument=username=…&password=…` 传给脚本，并把时间拼成 `cronexp="分 时 * * *"`，`myapi.js` 本身不用改，`myapi.sgmodule` 里也不用写明文账号密码。

- 密码里如果有 `&`，请写成 `%26`；有 `=`，请写成 `%3D`（脚本收到后会解码回来）。其他字符不用转义。
- 多账号：模块参数只支持单账号；多账号请改用下面的 BoxJS 方式，或直接改 `myapi.sgmodule` 里 `argument=` 行为 JSON：`argument={"accounts":[{"username":"a","password":"p1"},{"username":"b","password":"p2"}]}`。
- 也可以不填模块参数，改用 BoxJS：在 BoxJS 里填 `myapi_username`、`myapi_password`（多账号填 `myapi_accounts`，JSON 数组）。

⚠️ 账号密码只填在 Surge 模块参数 / BoxJS 本地，不要发到聊天、不要公开提交到仓库。`myapi.js` 和 `myapi.sgmodule` 本身不含任何账号密码。

> 需要较新版 Surge 才支持模块参数表（官方文档：Mac 5.5.0+ 起支持，iOS 也需较新版）。旧版 Surge 会忽略 `#!arguments`，届时仍需直接改文件里的 `argument=` 行，或用 BoxJS。

### 3. 导入 Surge

- 把改好的 `myapi.sgmodule` 传到一个可访问的 URL（同样可放 GitHub），在 Surge 里「模块 → 安装模块」粘贴该 URL；或用 Surge 的本地模块导入。
- 启用后每天在设定时间自动运行（默认 **09:00**），想改时间就改这一行。
- 也可以在 Surge 脚本列表里长按「MyAPI签到」手动立即运行一次，看通知结果。

### 改签到时间

不用改文件：在 Surge 模块列表里点开「MyAPI签到」→ **编辑参数**，改：

- `checkin_hour` —— 小时，0-23，默认 9
- `checkin_minute` —— 分钟，0-59，默认 0

例如每天 08:30 签到，就填 `checkin_hour` = 8、`checkin_minute` = 30。保存后模块重新应用，下次就按新时间跑。

## 运行结果

- `✅ 今日签到已确认` —— 登录成功，且在当天日志里找到了签到记录，通知里会显示本次奖励、当前余额、累计消耗、累计调用次数、签到时间。
- `⚠️ 签到待确认` —— 登录成功，但日志里暂时没找到今日记录（或余额查询失败），请到网站「使用日志」核对。
- `❌ 登录失败` —— 账号或密码不对，或网站要求验证码，请先在网页上确认登录，再更新模块里的账号密码。
- `🚫 未配置账号` —— argument / BoxJS 里都没填账号密码。

成功结果会写进 `myapi_status` 和公共索引 `checkin_registry`，可供「签到合集」类汇总脚本读取。

## 未验证的部分（实话）

- **真实账号的完整链路**：新流程是按 New-API v1.0.0-rc.x 的源码（`controller/user.go` 的 `writeLoginResponse`、`controller/checkin.go`、`model/checkin.go`）写的，并用模拟的新版接口响应做了两轮测试——未签到时 POST 签到成功、已签到时直接确认不重复 POST、假账号登录失败——三条分支都通过了。但没有真实账号，无法在 MyAPI 真站上跑通登录成功后的完整链路。第一次用真账号跑如果还显示“待确认”，请把通知原文发我，我再改。
- **签到奖励金额**：`POST /api/user/checkin` 直接返回 `quota_awarded`（原始额度整数），脚本按 `quota_per_unit=500000` 换算成美元显示，例如 5000 额度显示为 +$0.01。这个换算逻辑与余额显示一致，奖励数值本身来自接口，不用再猜日志格式。

## 调试

在 argument 里加 `&debug=true`（或 BoxJS 里 `myapi_debug` 设为 `true`），脚本会把每一步的 HTTP 状态打到 Surge 日志里。调试日志只含请求状态和签到判定，不含账号密码。
