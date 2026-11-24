# MyAPI Surge 签到模块

目标站：https://myapi.286600.xyz
改编来源：[MaYIHEI/paperclip `app/agentrouter`](https://github.com/MaYIHEI/paperclip/tree/main/app/agentrouter)（AgentRouter 签到，原作者 @773075692）

## 原理

MyAPI 和 AgentRouter 都是 New-API，接口完全相同，登录即签到：

| 步骤 | 请求 |
|---|---|
| 查余额显示配置 | `GET /api/status` → `display_in_currency`、`quota_per_unit` |
| 登录（= 签到） | `POST /api/user/login` `{"username","password"}` → `data.id`、`data.checked_in`、Set-Cookie `session=` |
| 查余额 | `GET /api/user/self`（带 `Cookie: session=…` 和 `New-API-User: <id>`）→ `quota`、`used_quota`、`request_count` |
| 确认签到记录 | `GET /api/log/self?p=1&page_size=20` → 找当天 `type=4`、内容含“签到成功”的记录 |

本站 `/api/status` 已实测验证（2026-11-25）：

- `checkin_enabled: true` —— 确实有每日签到
- `display_in_currency: true`，`quota_per_unit: 500000` —— 余额按 `$ = 额度 / 500000` 显示
- `password_login_enabled: true` —— 账号密码登录可用
- `github_oauth: false`，`linuxdo_oauth: false` —— **没有 GitHub 登录**
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

填好保存即可。模块会把它们拼成 `argument=username=…&password=…` 传给脚本，`myapi.js` 本身不用改，`myapi.sgmodule` 里也不用写明文账号密码。

- 密码里如果有 `&`，请写成 `%26`；有 `=`，请写成 `%3D`（脚本收到后会解码回来）。其他字符不用转义。
- 多账号：模块参数只支持单账号；多账号请改用下面的 BoxJS 方式，或直接改 `myapi.sgmodule` 里 `argument=` 行为 JSON：`argument={"accounts":[{"username":"a","password":"p1"},{"username":"b","password":"p2"}]}`。
- 也可以不填模块参数，改用 BoxJS：在 BoxJS 里填 `myapi_username`、`myapi_password`（多账号填 `myapi_accounts`，JSON 数组）。

⚠️ 账号密码只填在 Surge 模块参数 / BoxJS 本地，不要发到聊天、不要公开提交到仓库。`myapi.js` 和 `myapi.sgmodule` 本身不含任何账号密码。

> 需要较新版 Surge 才支持模块参数表（官方文档：Mac 5.5.0+ 起支持，iOS 也需较新版）。旧版 Surge 会忽略 `#!arguments`，届时仍需直接改文件里的 `argument=` 行，或用 BoxJS。

### 3. 导入 Surge

- 把改好的 `myapi.sgmodule` 传到一个可访问的 URL（同样可放 GitHub），在 Surge 里「模块 → 安装模块」粘贴该 URL；或用 Surge 的本地模块导入。
- 启用后每天 **09:00** 自动运行（`cronexp="0 9 * * *"`），想改时间就改这一行。
- 也可以在 Surge 脚本列表里长按「MyAPI签到」手动立即运行一次，看通知结果。

## 运行结果

- `✅ 今日签到已确认` —— 登录成功，且在当天日志里找到了签到记录，通知里会显示本次奖励、当前余额、累计消耗、累计调用次数、签到时间。
- `⚠️ 签到待确认` —— 登录成功，但日志里暂时没找到今日记录（或余额查询失败），请到网站「使用日志」核对。
- `❌ 登录失败` —— 账号或密码不对，或网站要求验证码，请先在网页上确认登录，再更新模块里的账号密码。
- `🚫 未配置账号` —— argument / BoxJS 里都没填账号密码。

成功结果会写进 `myapi_status` 和公共索引 `checkin_registry`，可供「签到合集」类汇总脚本读取。

## 未验证的部分（实话）

- **签到奖励金额格式**：AgentRouter 的日志是 `每日签到成功，增加额度 $0.01 额度`，脚本先按这个格式解析；MyAPI 未用真实账号跑过，脚本里额外加了一个分支——如果本站返回的是原始额度数字（例如 `增加额度 5000 额度`），会按 `quota_per_unit=500000` 换算成美元显示；两种都匹配不上时，通知会原样贴出日志内容的前 60 字，并提示到网站核对，但签到本身仍算已确认。
- **日志类型**：脚本按 New-API 通用的 `type=4` 找签到记录。如果 MyAPI 的签到记录用了别的 type，首次运行会报「未找到今日签到记录」，到时把网站使用日志里那条签到记录的 type 告诉我，我改一行就行。
- **登录接口本身已验证**：用假账号实测 `POST /api/user/login`，服务器正常返回 JSON（`success:false`），接口、请求头、JSON 解析都没问题；只是没有真实账号，无法验证登录成功后的完整链路。

## 调试

在 argument 里加 `&debug=true`（或 BoxJS 里 `myapi_debug` 设为 `true`），脚本会把每一步的 HTTP 状态打到 Surge 日志里。调试日志只含请求状态和签到判定，不含账号密码。
