/**
 * MyAPI · 每日登录签到，查看奖励、余额与累计消耗
 *
 * 目标站：https://myapi.286600.xyz
 * （New-API v1.0.0-rc.36，/api/status 已验证：checkin_enabled=true，
 *  display_in_currency=true，quota_per_unit=500000，password_login_enabled=true，
 *  github_oauth=false，linuxdo_oauth=false，仅 NODELOC 第三方登录，
 *  turnstile_check=false）
 *
 * 原理（新版 New-API v1.0.0-rc.x，与 AgentRouter 老版本不同）：
 *   POST /api/user/login {username, password}
 *     -> data: {access_token, token_type, access_expires_at, session,
 *               user: {id, username, quota, used_quota, request_count, ...}}
 *     注意：新版登录不再返回顶层 data.id / data.checked_in，
 *     也不再发 session Cookie，改发 Bearer access_token。
 *     （旧脚本按老版本写，才报“登录响应缺少 Cookie 或用户编号”。）
 *   之后所有请求带：
 *     Authorization: Bearer <access_token>
 *     New-API-User: <user_id>
 *   GET  /api/user/self
 *     -> data.quota、data.used_quota、data.request_count
 *   GET  /api/user/checkin?month=YYYY-MM
 *     -> data: {enabled, min_quota, max_quota,
 *               stats: {total_quota, total_checkins, checkin_count,
 *                       checked_in_today, records: [{checkin_date, quota_awarded}]}}
 *   POST /api/user/checkin
 *     -> 成功：data: {quota_awarded, checkin_date}，message "Check-in successful"
 *     -> 今日已签过：success=false，message "Already checked in today"
 *     （登录本身不再自动签到，必须显式调这个接口；本站 turnstile 已关，
 *     不需要 Turnstile 票据。）
 *
 * 流程：登录 → 查余额 → 查今日签到状态 → 未签到则 POST 签到 → 再查一次余额。
 * 今天已签到过时不重复 POST，直接按状态接口确认并显示今日奖励。
 *
 * 账号填写（三选一，优先 $argument）：
 *   1. Surge 模块参数（推荐）：myapi.sgmodule 里用 #!arguments 声明了
 *      username、password，导入模块后在 Surge「编辑参数」里填写，
 *      模块会把它们拼成 argument=username=...&password=... 传给脚本。
 *      密码里有 & 请写成 %26，有 = 请写成 %3D（脚本会解码回来）。
 *   2. Surge 脚本的 argument 参数（字符串）：
 *        argument=username=你的账号&password=你的密码
 *      或 JSON：
 *        argument={"username":"你的账号","password":"你的密码"}
 *      多账号 JSON：
 *        argument={"accounts":[{"username":"a","password":"p1"},{"username":"b","password":"p2"}]}
 *   3. BoxJS / $persistentStore：
 *        myapi_username、myapi_password
 *      多账号时在 BoxJS 填 myapi_accounts（JSON 数组，同上格式）。
 *
 * 注意：本站没有 GitHub 登录入口，NODELOC / Passkey 需要浏览器交互，
 * 无法在 Surge 定时任务里完成，所以本脚本只能用账号密码登录。
 * 请勿把账号密码发到聊天或公开仓库，只填在 Surge / BoxJS 本地。
 *
 * 签到：cron 每天在模块参数设定的时间自动运行（默认 09:00）。
 * 时间在 myapi.sgmodule 的「编辑参数」里改：checkin_hour（0-23，默认 9）、
 * checkin_minute（0-59，默认 0），例如 8 点 30 分就填 8 和 30。结果未确认时请到网站核对。
 *
 * 改编自：MaYIHEI paperclip app/agentrouter
 *   https://github.com/MaYIHEI/paperclip/tree/main/app/agentrouter
 *   原作者 @773075692，改编者 MaYIHEI
 * 本版改编：Muse，按 https://myapi.286600.xyz 的 /api/status 适配，
 * 并按 New-API v1.0.0-rc.x 的源码（controller/user.go 的 writeLoginResponse、
 * controller/checkin.go、model/checkin.go）重写了登录与签到流程。
 *
 * ===== Surge =====
 * [Script]
 * MyAPI签到 = type=cron,cronexp="0 9 * * *",timeout=60,script-path=https://cdn.jsdelivr.net/gh/JiuYueQingCheng/myapi-surge-checkin@main/myapi.js,argument=username=你的账号&password=你的密码
 * 也可以直接用随附的 myapi.sgmodule 导入 Surge（见 README.md）。
 *
 * ===== Loon / Quantumult X / Stash =====
 * 与 AgentRouter 原脚本用法相同，Loon 的 $argument 是对象，
 * Quantumult X / Stash 用 BoxJS 填账号。
 */

const $ = new Env("MyAPI");

// 签到合集开启「统一通知」时不单独弹通知，结果由签到汇总统一发送
$.merge = typeof $argument === "object" && !!$argument && $argument.merge === true;

if ($.merge) $.msg = (...a) => console.log(a.filter((x) => typeof x === "string" && x).join("\n"));

const SCRIPT_VERSION = "2026-11-25.r2";

$.log(`[INFO] 脚本版本 ${SCRIPT_VERSION}`);

const USER_KEY = "myapi_username";
const PASSWORD_KEY = "myapi_password";
const ACCOUNTS_KEY = "myapi_accounts";
const CLEAR_KEY = "myapi_clear";
const DEBUG_KEY = "myapi_debug";

const IS_LOON = $.isLoon();

// $argument 在 Surge 里是字符串，在 Loon 里是对象，在 QX/Stash 里不存在。
// 统一解析成对象，解析失败时当作空对象。
const PLUGIN = parseArgument(typeof $argument !== "undefined" ? $argument : null);

const SETTINGS_PAGE = IS_LOON ? "Loon 插件设置或 BoxJS" : "BoxJS / Surge 模块 argument";

const BASE_URL = "https://myapi.286600.xyz";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

run().catch((error) => {
    // 只输出脚本主动生成的错误，不转储账号、请求和原始响应。
    saveStatus("fail", error.message);
    $.msg($.name, "❌ 运行失败", error.message);
}).finally(() => $.done());

function parseArgument(raw) {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    if (typeof raw !== "string") return {};
    const text = raw.trim();
    if (!text) return {};
    // JSON：{"username":"...","password":"..."} 或 {"accounts":[...]}
    if (text.startsWith("{")) {
        try { return JSON.parse(text); } catch (_) { return {}; }
    }
    // 查询串：username=...&password=...&debug=true
    const out = {};
    for (const part of text.split("&")) {
        const eq = part.indexOf("=");
        if (eq <= 0) continue;
        const k = decodeURIComponent(part.slice(0, eq).trim());
        const v = decodeURIComponent(part.slice(eq + 1).trim());
        if (k) out[k] = v;
    }
    return out;
}

async function run() {
    const clear = $.getdata(CLEAR_KEY);

    if (clear === "true" || clear === "1") {
        const userCleared = $.setdata("", USER_KEY);
        const passwordCleared = $.setdata("", PASSWORD_KEY);
        if (!userCleared || !passwordCleared) {
            throw new Error("账号信息清除失败，请在 BoxJS 中检查并手动清空");
        }
        $.setdata("false", CLEAR_KEY);
        $.msg($.name, "✅ 账号信息已清除", "需要继续签到时，请在 BoxJS 重新填写账号和密码");
        return;
    }

    const accounts = readAccounts();

    if (!accounts.length) {
        saveStatus("none", "未配置账号");
        $.msg($.name, "🚫 未配置账号", `请在 ${SETTINGS_PAGE} 的 MyAPI 中分别填写账号和密码并保存`);
        return;
    }

    let quotaUnit = null;

    try {
        const status = await request("GET", "/api/status", { Accept: "application/json" }, undefined, "余额显示配置查询");
        const config = status.json.data;
        if (status.json.success === true && config && config.display_in_currency === true
            && typeof config.quota_per_unit === "number" && Number.isFinite(config.quota_per_unit) && config.quota_per_unit > 0) {
            quotaUnit = config.quota_per_unit;
        }
    } catch (_) {
        debug("余额显示配置未取得，将显示原始额度");
    }

    const results = [];

    for (let i = 0; i < accounts.length; i++) {
        debug(`开始账号 ${i + 1}/${accounts.length}`);
        try {
            results.push(await checkin(accounts[i], quotaUnit));
        } catch (error) {
            results.push({ title: "❌ 运行失败", content: error.message });
        }
    }

    // 登录失败 = 账号密码需要更新，对应体检里的「需重新抓取」
    const loginFailed = results.some((result) => result.title === "❌ 登录失败");
    const failed = results.find((result) => result.title === "❌ 运行失败");

    if (loginFailed) saveStatus("cookie", "登录失败,请检查账号密码");
    else if (failed) saveStatus("fail", failed.content);
    else saveStatus("ok", results.map((result) => result.content.split("\n")[0].replace(/^🎁\s*/, "")).join(" · "), results.length === 1 ? results[0].balance : undefined); // 多账号不合并余额

    if (results.length === 1) {
        $.msg($.name, results[0].title, `👤 账号：${maskAccount(accounts[0].username)}\n${results[0].content}`);
    } else {
        $.msg($.name, `签到汇总（${results.length} 个账号）`, results.map((result, i) =>
            `👤 账号 ${i + 1} · ${maskAccount(accounts[i].username)}\n${result.title}\n${result.content}`).join("\n\n"));
    }
}

function readAccounts() {
    // 1. $argument（Surge 字符串 / Loon 对象）里的多账号
    const multi = PLUGIN.accounts;
    if (multi) {
        let accounts;
        if (typeof multi === "string") {
            try { accounts = JSON.parse(multi); } catch (_) {
                throw new Error("多账号格式错误，请按使用说明填写 JSON 数组");
            }
        } else {
            accounts = multi;
        }
        if (!Array.isArray(accounts) || !accounts.length) {
            throw new Error("多账号必须是非空 JSON 数组；使用单账号时请清空多账号输入框");
        }
        return accounts.map((account, i) => {
            if (!account || typeof account.username !== "string" || !account.username.trim()
                || typeof account.password !== "string" || !account.password) {
                throw new Error(`多账号第 ${i + 1} 项缺少有效的 username 或 password，请检查插件设置`);
            }
            return { username: account.username.trim(), password: account.password };
        });
    }

    // 2. BoxJS 里存的多账号
    const storedMulti = $.getdata(ACCOUNTS_KEY);
    if (storedMulti) {
        try {
            const accounts = JSON.parse(storedMulti);
            if (Array.isArray(accounts) && accounts.length) {
                return accounts.map((account, i) => {
                    if (!account || typeof account.username !== "string" || !account.username.trim()
                        || typeof account.password !== "string" || !account.password) {
                        throw new Error(`多账号第 ${i + 1} 项缺少有效的 username 或 password`);
                    }
                    return { username: account.username.trim(), password: account.password };
                });
            }
        } catch (e) {
            if (e.message && e.message.includes("多账号第")) throw e;
            throw new Error("BoxJS 多账号格式错误，请填写 JSON 数组");
        }
    }

    // 3. 单账号：$argument 优先，其次 BoxJS / $persistentStore
    const username = (PLUGIN.username || $.getdata(USER_KEY) || "").trim();
    const password = PLUGIN.password || $.getdata(PASSWORD_KEY) || "";

    return username && password ? [{ username, password }] : [];
}

function parseUserId(value) {
    if (Number.isInteger(value) && value > 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
        const n = Number(value.trim());
        if (Number.isInteger(n) && n > 0) return n;
    }
    return null;
}

function monthString(now) {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function dateString(now) {
    const d = new Date(now);
    return `${monthString(now)}-${String(d.getDate()).padStart(2, "0")}`;
}

async function checkin({ username, password }, quotaUnit) {
    const headers = {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/login`,
    };

    const login = await request("POST", "/api/user/login", headers, JSON.stringify({ username, password }), "登录");

    if (login.json.success !== true) {
        return { title: "❌ 登录失败", content: `请先在 MyAPI 网页确认账号、密码及是否需要验证码，再更新 ${SETTINGS_PAGE}` };
    }

    const data = login.json.data;

    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { title: "⚠️ 签到待确认", content: "登录成功，但响应缺少用户信息，请到网站核对签到记录与余额" };
    }

    // 新版登录：data.user.id + data.access_token；
    // 老版本兼容：data.id + Set-Cookie: session=...
    const loginUser = data.user && typeof data.user === "object" && !Array.isArray(data.user) ? data.user : data;
    let userId = parseUserId(loginUser.id);
    const accessToken = typeof data.access_token === "string" && data.access_token ? data.access_token : "";
    const cookie = sessionCookie(login.headers);

    debug(`登录成功；auth=${accessToken ? "Bearer" : cookie ? "Cookie" : "无"}；userId=${userId === null ? "缺失" : "已取得"}`);

    if (!accessToken && !cookie) {
        return { title: "⚠️ 签到待确认", content: "登录成功，但响应里既没有访问令牌也没有 Cookie，无法继续查询，请到网站核对" };
    }

    // 新版用 Bearer + New-API-User；老版本用 Cookie。
    // Surge 的 $httpClient 默认会自动管理 Cookie，所以只在非 Surge 下手动带 Cookie。
    const authHeaders = {
        ...headers,
        Referer: `${BASE_URL}/console`,
    };
    if (accessToken) authHeaders["Authorization"] = `Bearer ${accessToken}`;
    if (userId !== null) authHeaders["New-API-User"] = String(userId);
    if (cookie && !$.isSurge()) authHeaders["Cookie"] = cookie;

    // 1. 查余额（顺便从这里补 userId：登录没给时，self 接口会返回 id）
    let stats = "";
    let balance;
    try {
        const profile = await fetchProfile(authHeaders, quotaUnit);
        stats = profile.stats;
        balance = profile.balance;
        if (userId === null && profile.userId !== null) {
            userId = profile.userId;
            authHeaders["New-API-User"] = String(userId);
        }
    } catch (error) {
        stats = `💳 当前余额：查询失败\n📉 累计消耗：查询失败\n${error.message}`;
    }

    // 2. 查今日签到状态
    const today = dateString(Date.now());
    let checkinStatus = null;
    let statusError = "";
    try {
        const statusRes = await request("GET", `/api/user/checkin?month=${monthString(Date.now())}`, authHeaders, undefined, "签到状态查询");
        if (statusRes.json.success !== true || !statusRes.json.data || typeof statusRes.json.data !== "object") {
            throw new Error("签到状态查询未成功，请在网站核对");
        }
        checkinStatus = statusRes.json.data;
        debug(`签到状态：enabled=${checkinStatus.enabled}；今日已签=${checkinStatus.stats && checkinStatus.stats.checked_in_today}`);
    } catch (error) {
        statusError = error.message;
        debug(`签到状态查询失败：${statusError}`);
    }

    // 3. 今天已签到过：直接确认，不重复 POST
    if (checkinStatus && checkinStatus.stats && checkinStatus.stats.checked_in_today === true) {
        const record = findTodayRecord(checkinStatus.stats.records, today);
        const reward = record
            ? formatQuotaReward(record.quota_awarded, quotaUnit, false)
            : "🎁 今日奖励：已签到（今日记录未返回，请到网站核对）";
        return { title: "✅ 今日签到已确认", content: `${reward}\n${stats}\n🕒 签到日期：${today}（今日已签到）`, balance };
    }

    // 签到功能未开启时，状态接口会直接报 enabled=false
    if (checkinStatus && checkinStatus.enabled === false) {
        return { title: "⚠️ 签到待确认", content: `🎁 签到奖励：待确认\n${stats}\n\n本站签到功能未开启\n${statusError}`, balance };
    }

    // 4. 未签到：POST 签到
    let doRes;
    try {
        doRes = await request("POST", "/api/user/checkin", authHeaders, undefined, "签到");
    } catch (error) {
        return { title: "⚠️ 签到待确认", content: `🎁 签到奖励：待确认\n${stats}\n\n签到请求失败\n${error.message}`, balance };
    }

    if (doRes.json.success === true && doRes.json.data && typeof doRes.json.data === "object") {
        const awarded = doRes.json.data.quota_awarded;
        const checkinDate = doRes.json.data.checkin_date || today;
        // 奖励已入账，重新查一次余额
        try {
            const profile = await fetchProfile(authHeaders, quotaUnit);
            stats = profile.stats;
            balance = profile.balance;
        } catch (_) {
            debug("签到后余额刷新失败，沿用签到前余额");
        }
        return { title: "✅ 今日签到已确认", content: `${formatQuotaReward(awarded, quotaUnit, true)}\n${stats}\n🕒 签到日期：${checkinDate}`, balance };
    }

    // 今日已签过（竞态：状态查询时还没签，POST 时已签）
    const message = typeof doRes.json.message === "string" ? doRes.json.message : "";
    if (/Already checked in/i.test(message)) {
        try {
            const again = await request("GET", `/api/user/checkin?month=${monthString(Date.now())}`, authHeaders, undefined, "签到状态复查");
            if (again.json.success === true && again.json.data && again.json.data.stats && again.json.data.stats.checked_in_today === true) {
                const record = findTodayRecord(again.json.data.stats.records, today);
                const reward = record
                    ? formatQuotaReward(record.quota_awarded, quotaUnit, false)
                    : "🎁 今日奖励：已签到（今日记录未返回，请到网站核对）";
                return { title: "✅ 今日签到已确认", content: `${reward}\n${stats}\n🕒 签到日期：${today}（今日已签到）`, balance };
            }
        } catch (_) {}
        return { title: "✅ 今日签到已确认", content: `🎁 今日奖励：今日已签到\n${stats}\n🕒 签到日期：${today}`, balance };
    }

    return { title: "⚠️ 签到待确认", content: `🎁 签到奖励：待确认\n${stats}\n\n签到未成功：${message || "请到网站核对"}${statusError ? `\n${statusError}` : ""}`, balance };
}

async function fetchProfile(authHeaders, quotaUnit) {
    const profile = await request("GET", "/api/user/self", authHeaders, undefined, "余额查询");
    const user = profile.json.data;
    const quota = user && user.quota;
    if (profile.json.success !== true || typeof quota !== "number" || !Number.isFinite(quota)) {
        throw new Error("余额查询未返回有效额度，请到网站核对");
    }
    const stats = `${formatAmount("💳 当前余额", quota, quotaUnit)}\n${formatAmount("📉 累计消耗", user.used_quota, quotaUnit)}`;
    const balance = quotaUnit === null ? `额度 ${quota}` : `余额 $${(quota / quotaUnit).toFixed(2)}`;
    let fullStats = stats;
    if (Number.isInteger(user.request_count) && user.request_count >= 0) {
        fullStats += `\n⚡ 累计调用：${user.request_count} 次`;
    }
    return { stats: fullStats, balance, userId: parseUserId(user.id) };
}

// 记录本次结果，供「签到汇总」：ok 正常 / cookie 需重新抓取 / fail 其他失败 / none 未使用
function saveStatus(s, msg, asset) {
    msg = String(msg).slice(0, 100);

    // 服务器明确提示登录过期的失败，按需要重新抓取处理
    if (s === "fail" && /过期|重新登录|未登录|请登录|登录失效|登录已失效|token\s*(失效|过期|无效)|not\s*login/i.test(msg)) s = "cookie";

    // 同一天已有带奖励的成功记录时，再次运行得到的「今日已签」不覆盖它的奖励文字，只合并本次的资产等信息
    let keep = null;

    if (s === "ok" && /^今日已/.test(msg)) {
        const day = (t) => new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
        let old = null;
        try { old = JSON.parse($.getdata("myapi_status") || "null"); } catch (e) {}
        if (old && old.s === "ok" && !/^今日已/.test(old.msg) && day(old.t) === day(Date.now())) keep = old;
    }

    checkinReport("myapi_status", keep ? keepReward(keep, { s, msg, asset }) : { s, msg, asset }, { name: "MyAPI", author: "Muse" });
}

function maskAccount(username) {
    const name = username.split("@")[0];
    return name.length > 4 ? `${name.slice(0, 2)}***${name.slice(-2)}` : `${name.slice(0, 1)}***`;
}

function formatAmount(label, value, quotaUnit) {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${label}：未返回`;
    return quotaUnit === null ? `${label}（原始额度）：${value}` : `${label}：$${(value / quotaUnit).toFixed(2)}`;
}

// quota_awarded 是原始额度（整数），按 quota_per_unit 换算成美元显示。
function formatQuotaReward(quotaAwarded, quotaUnit, isNew) {
    const label = isNew ? "🎁 本次奖励" : "🎁 今日奖励";
    if (typeof quotaAwarded !== "number" || !Number.isFinite(quotaAwarded)) {
        return `${label}：金额未识别，请到网站核对`;
    }
    if (quotaUnit === null) return `${label}：+${quotaAwarded} 额度${isNew ? "" : "（今日记录）"}`;
    return `${label}：+$${(quotaAwarded / quotaUnit).toFixed(2)}（原始额度 ${quotaAwarded}）${isNew ? "" : "（今日记录）"}`;
}

function findTodayRecord(records, today) {
    if (!Array.isArray(records)) return null;
    for (const record of records) {
        if (record && record.checkin_date === today && typeof record.quota_awarded === "number") return record;
    }
    return null;
}

function sessionCookie(headers) {
    const key = Object.keys(headers).find((name) => name.toLowerCase() === "set-cookie");
    const raw = key ? [].concat(headers[key]).join("\n") : "";
    // 仅复用 session；不把 Expires 中的逗号或其他 Set-Cookie 属性当作 Cookie。
    const match = raw.match(/(?:^|[\n,])\s*(?:set-cookie:\s*)?(session=[^;\s,]+)/i);
    return match ? match[1] : "";
}

function request(method, path, headers, body, label) {
    return new Promise((resolve, reject) => {
        const options = { url: BASE_URL + path, headers };
        if (body !== undefined) options.body = body;

        // 账号密码只发给固定 HTTPS 站点；Loon 默认允许不受信任证书，需显式关闭。
        if ($.isLoon()) {
            options.insecure = false;
            options["auto-redirect"] = false;
            // 每个账号只使用本次登录拿到的 session，禁止 Cookie 自动沿用到下一个账号。
            options["auto-cookie"] = false;
        }

        $.send(options, method, (error, response, text) => {
            if (error) {
                reject(new Error(`${label}网络请求失败，请检查该网站的 Surge 分流或稍后重试`));
                return;
            }

            const status = Number(response && (response.status || response.statusCode));
            debug(`${label} HTTP ${status}`);

            if (status < 200 || status >= 300 || !status) {
                reject(new Error(`${label}返回 HTTP ${status || "未知"}，请在浏览器确认网站是否可访问或需要验证`));
                return;
            }

            let json;
            try {
                json = JSON.parse(text);
            } catch (_) {
                reject(new Error(`${label}返回非 JSON 内容，可能是网页验证或服务异常，请到网站检查`));
                return;
            }

            if (!json || typeof json !== "object" || Array.isArray(json)) {
                reject(new Error(`${label}响应格式异常，请到网站检查`));
                return;
            }

            resolve({ json, headers: response.headers || {} });
        });
    });
}

function debug(message) {
    if (PLUGIN.debug === true || PLUGIN.debug === "true" || $.getdata(DEBUG_KEY) === "true") $.log(`[DEBUG] ${message}`);
}

// 保留当天带奖励的旧记录（状态、奖励文字、时间），合并本次拿到的资产、过期时间等；本次没有的沿用旧值
function keepReward(old, rec) {
    const out = { s: old.s, msg: old.msg, t: old.t, asset: old.asset, exp: old.exp };
    for (const k in rec) if (rec[k] !== undefined && k !== "s" && k !== "msg") out[k] = rec[k];
    return out;
}

// 签到状态协议 v1：写本次结果，并把自己登记进公共索引 checkin_registry（Loon/Surge/QX/Stash 通用，不依赖 Env）
function checkinReport(key, rec, info) {
    const read = (k) => (typeof $prefs !== "undefined" ? $prefs.valueForKey(k) : $persistentStore.read(k));
    const write = (v, k) => (typeof $prefs !== "undefined" ? $prefs.setValueForKey(v, k) : $persistentStore.write(v, k));
    const registry = () => { try { return JSON.parse(read("checkin_registry") || "{}") || {}; } catch (e) { return {}; } };
    write(JSON.stringify(Object.assign({ v: 1, t: Date.now(), name: info.name, author: info.author }, rec)), key);
    const reg = registry();
    if (JSON.stringify(reg[key]) === JSON.stringify(info)) return;
    reg[key] = info;
    write(JSON.stringify(reg), "checkin_registry");
    if (!registry()[key]) console.log(`[checkin] ${key} 登记没写上，下次运行再补`);
}

function Env(s) {
    this.name = s;
    this.isSurge = () => typeof $httpClient !== "undefined";
    this.isQuanX = () => typeof $task !== "undefined";
    this.isLoon = () => typeof $loon !== "undefined";
    this.log = (...a) => console.log(a.join("\n"));
    this.msg = (t = this.name, s = "", b = "") => {
        if (this.isSurge() || this.isLoon()) $notification.post(t, s, b);
        else if (this.isQuanX()) $notify(t, s, b);
        console.log(["", `====📣${t}====`, s, b].filter(Boolean).join("\n"));
    };
    this.getdata = (k) => {
        if (this.isSurge() || this.isLoon()) return $persistentStore.read(k);
        if (this.isQuanX()) return $prefs.valueForKey(k);
        return null;
    };
    this.setdata = (v, k) => {
        if (this.isSurge() || this.isLoon()) return $persistentStore.write(v, k);
        if (this.isQuanX()) return $prefs.setValueForKey(v, k);
        return false;
    };
    this.send = (req, method, cb) => {
        if (this.isSurge() || this.isLoon()) {
            const fn = method === "POST" ? $httpClient.post : $httpClient.get;
            fn(req, (err, resp, data) => {
                if (resp) {
                    resp.body = data;
                    resp.statusCode = resp.status || resp.statusCode;
                }
                cb(err, resp, data);
            });
        } else if (this.isQuanX()) {
            req.method = method;
            $task.fetch(req).then(
                (r) => {
                    r.status = r.statusCode;
                    cb(null, r, r.body);
                },
                (e) => cb(e.error || e, null, null),
            );
        }
    };
    this.done = (v = {}) => {
        if (typeof $done !== "undefined") $done(v);
    };
}
