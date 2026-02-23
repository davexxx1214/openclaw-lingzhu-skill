/**
 * EasyAR + Rokid 灵珠 AR 导航 SSE 服务
 *
 * 功能：接收灵珠平台的图片识别请求，调用 EasyAR 云识别，
 *       解析导航信息后通过 SSE 返回 take_navigation 命令。
 *
 * 跨平台支持：Windows / Linux
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { recognize, parseMeta, downloadImageAsBase64, getTokenFromLocal } = require('./easyar-client');

// ─── 配置加载 ──────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'application.txt');

function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        console.error(`[配置] 无法读取 ${CONFIG_PATH}:`, e.message);
        process.exit(1);
    }
}

const config = loadConfig();
const cloudConfig = config.cloud || {};
const lingzhuConfig = config.lingzhu || {};

const EASYAR_API_KEY = cloudConfig.apiKey;
const EASYAR_API_SECRET = cloudConfig.apiSecret;
const EASYAR_CRS_APPID = cloudConfig.crsAppId;
const EASYAR_CLIENT_END_URL = cloudConfig.clientEndUrl;
const WEBAR_PORT = parseInt((config.web?.port || ':3000').replace(':', ''), 10);

const LINGZHU_PORT = lingzhuConfig.port || 18789;
const LINGZHU_AUTH_AK = lingzhuConfig.authAk || crypto.randomUUID();
const LINGZHU_FORCE_TAKE_PHOTO = lingzhuConfig.forceTakePhoto === true;
const LINGZHU_MAX_RETRIES = parseInt(lingzhuConfig.maxRetries, 10) || 3;
// Rokid 眼镜端超时约 3-4 秒，留 500ms 余量给响应发送
const GLASSES_TIMEOUT_MS = parseInt(lingzhuConfig.glassesTimeoutMs, 10) || 2800;

// ─── 用户重试计数（按 user_id 跟踪连续识别失败次数） ──────────

const retryCountMap = new Map();
const RETRY_EXPIRE_MS = 5 * 60 * 1000;

function getRetryCount(userId) {
    const entry = retryCountMap.get(userId);
    if (!entry) return 0;
    if (Date.now() - entry.ts > RETRY_EXPIRE_MS) {
        retryCountMap.delete(userId);
        return 0;
    }
    return entry.count;
}

function incrementRetry(userId) {
    const count = getRetryCount(userId) + 1;
    retryCountMap.set(userId, { count, ts: Date.now() });
    return count;
}

function resetRetry(userId) {
    retryCountMap.delete(userId);
}

// ─── Token 缓存 ────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiry = 0;

async function ensureToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpiry) {
        return cachedToken;
    }
    try {
        // 优先从本地 EasyAR exe 获取 token
        const result = await getTokenFromLocal(WEBAR_PORT);
        cachedToken = result;
        tokenExpiry = now + 80000 * 1000; // 约 22 小时后失效
        console.log('[Token] 已从本地 EasyAR 服务获取 token');
        return cachedToken;
    } catch (e) {
        console.warn('[Token] 本地 EasyAR 服务不可用:', e.message);
        console.warn('[Token] 请确保 EasyAR_WebAR 服务正在运行');
        throw new Error('无法获取 EasyAR token，请先启动 EasyAR WebAR 服务');
    }
}

// ─── SSE 响应工具函数（遵循灵珠平台协议） ─────────────────────
//
// 输出格式（官方示例）:
//   event:message
//   data:{"role":"agent","type":"answer","answer_stream":"hello","message_id":"xxx","is_finish":false}

function sendSSE(res, data) {
    const json = JSON.stringify(data);
    console.log(`[SSE] >> event:message data:${json}`);
    res.write(`event:message\ndata:${json}\n\n`);
}

function sendSSEDone(res, messageId, agentId) {
    // Rokid 客户端对 [DONE] 兼容较差，这里使用 JSON done 事件
    const doneData = {
        role: 'agent',
        type: 'answer',
        answer_stream: '',
        message_id: messageId,
        agent_id: agentId,
        is_finish: true,
    };
    const json = JSON.stringify(doneData);
    console.log(`[SSE] >> event:done data:${json}`);
    res.write(`event:done\ndata:${json}\n\n`);
    res.end();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamAnswer(res, messageId, agentId, text) {
    return new Promise((resolve) => {
        // 先发内容（is_finish=false）
        sendSSE(res, {
            role: 'agent',
            type: 'answer',
            answer_stream: text,
            message_id: messageId,
            agent_id: agentId,
            is_finish: false,
        });
        // 短暂延迟后发结束标记（is_finish=true）
        setTimeout(() => {
            sendSSE(res, {
                role: 'agent',
                type: 'answer',
                answer_stream: text,
                message_id: messageId,
                agent_id: agentId,
                is_finish: true,
            });
            resolve();
        }, 50);
    });
}

function sendAnswer(res, messageId, agentId, text, isFinish = false) {
    sendSSE(res, {
        role: 'agent',
        type: 'answer',
        answer_stream: text,
        message_id: messageId,
        agent_id: agentId,
        is_finish: isFinish,
    });
}

function sendToolCall(res, messageId, agentId, toolCall) {
    sendSSE(res, {
        role: 'agent',
        type: 'tool_call',
        tool_call: toolCall,
        message_id: messageId,
        agent_id: agentId,
        is_finish: true,
    });
}

// ─── Express 应用 ──────────────────────────────────────────────

const app = express();

// URL 清理中间件 —— 去除路径末尾的 %20（空格）和多余斜杠
app.use((req, res, next) => {
    const cleaned = req.url.replace(/%20+$/g, '').replace(/\/+$/, '') || '/';
    if (cleaned !== req.url) {
        console.log(`[URL清理] "${req.url}" → "${cleaned}"`);
        req.url = cleaned;
    }
    next();
});

// 请求日志中间件 —— 所有请求都会打印（含实际响应时间）
app.use((req, res, next) => {
    const startTs = new Date().toISOString();
    const startMs = Date.now();
    console.log(`[${startTs}] --> ${req.method} ${req.url} from ${req.ip}`);
    console.log(`[${startTs}]     Headers: ${JSON.stringify(req.headers)}`);
    res.on('finish', () => {
        const endTs = new Date().toISOString();
        console.log(`[${endTs}] <-- ${req.method} ${req.url} ${res.statusCode} (${Date.now() - startMs}ms)`);
    });
    next();
});

app.use(express.json({ limit: '50mb' }));

// JSON 解析错误处理
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        console.error('[请求] JSON 解析失败:', err.message);
        return res.status(400).json({ error: '请求体 JSON 格式错误' });
    }
    next(err);
});

// 鉴权中间件
function authMiddleware(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        console.warn('[鉴权] 失败: 缺少 Authorization header');
        return res.status(401).json({ error: '缺少 Authorization header' });
    }
    const ak = auth.slice(7);
    if (ak !== LINGZHU_AUTH_AK) {
        console.warn(`[鉴权] 失败: AK 不匹配 (收到: ${ak.slice(0, 8)}...)`);
        return res.status(403).json({ error: '鉴权失败' });
    }
    console.log('[鉴权] 通过');
    next();
}

// 健康检查
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'lingzhu-ar-navigation' });
});

// 灵珠 SSE 端点
app.post('/metis/agent/api/sse', authMiddleware, async (req, res) => {
    console.log('[SSE] 收到灵珠请求, body:', JSON.stringify(req.body, null, 2));

    const { message_id, agent_id, message, metadata, user_id } = req.body;
    const messageId = message_id || crypto.randomUUID();
    const agentId = agent_id || 'easyar-navi';
    const userId = user_id || 'anonymous';
    const reqStartMs = Date.now();

    // 设置 SSE 响应头
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }
    // 禁用 Nagle 算法，确保 SSE 数据立即推送
    if (res.socket) {
        res.socket.setNoDelay(true);
    }

    // 客户端断开检测
    let clientGone = false;
    req.on('close', () => {
        if (!res.writableEnded) {
            clientGone = true;
            console.log(`[SSE] ⚠ 客户端在 ${Date.now() - reqStartMs}ms 时断开连接`);
        }
    });

    // 心跳定时器 —— 在长耗时图片处理期间保持 SSE 连接活跃
    let keepAliveTimer = null;
    function startKeepAlive() {
        keepAliveTimer = setInterval(() => {
            if (clientGone || res.writableEnded) {
                clearInterval(keepAliveTimer);
                return;
            }
            try {
                res.write(`: heartbeat ${Date.now()}\n\n`);
                console.log(`[SSE] >> heartbeat (${Date.now() - reqStartMs}ms)`);
            } catch (_) {
                clearInterval(keepAliveTimer);
            }
        }, 1500);
    }
    function stopKeepAlive() {
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
    }

    try {
        // 提取图片和文本
        const messages = message || [];
        let imageUrl = null;
        let userText = '';

        for (const msg of messages) {
            if (msg.type === 'image') {
                const candidate = msg.image_url || msg.text || msg.url;
                if (candidate) {
                    imageUrl = candidate;
                }
            }
            if (msg.type === 'text') {
                if (msg.text) userText += msg.text + ' ';
                if (!imageUrl && typeof msg.image_url === 'string' && msg.image_url.trim()) {
                    imageUrl = msg.image_url.trim();
                }
            }
        }

        console.log(`[SSE] 提取结果: userText="${userText.trim()}", imageUrl=${imageUrl || '(无)'}`);

        const textForIntent = (userText || '').trim();

        // 无图片分支 —— 快速响应
        if (!imageUrl) {
            resetRetry(userId);
            if (LINGZHU_FORCE_TAKE_PHOTO || /拍照|拍一下|识别|扫一扫|看看/.test(textForIntent)) {
                sendAnswer(res, messageId, agentId, '收到，正在为你打开拍照识别。');
                sendToolCall(res, messageId, agentId, {
                    command: 'take_photo',
                });
                sendSSEDone(res, messageId, agentId);
                return;
            }

            await streamAnswer(res, messageId, agentId, '请拍照后发送图片，我会识别并导航到对应地点。');
            sendSSEDone(res, messageId, agentId);
            return;
        }

        // ── 图片处理分支 —— 耗时操作，需要保活 ──

        // 立即发送第一条数据，防止客户端因空闲超时断开
        sendAnswer(res, messageId, agentId, '正在识别图片，请稍候...');
        startKeepAlive();

        // 1. 下载图片并转 Base64
        console.log(`[识别] 下载图片: ${imageUrl}`);
        let imageBase64;
        try {
            imageBase64 = await downloadImageAsBase64(imageUrl);
            console.log(`[计时] 图片下载+转码: ${Date.now() - reqStartMs}ms`);
        } catch (e) {
            stopKeepAlive();
            if (clientGone) { console.log('[SSE] 客户端已断开, 跳过响应'); return; }
            sendAnswer(res, messageId, agentId, `图片下载失败: ${e.message}`);
            sendToolCall(res, messageId, agentId, { command: 'take_photo' });
            sendSSEDone(res, messageId, agentId);
            return;
        }

        // 2. 获取 token
        let tokenResult;
        try {
            tokenResult = await ensureToken();
            console.log(`[计时] 获取token: ${Date.now() - reqStartMs}ms`);
        } catch (e) {
            stopKeepAlive();
            if (clientGone) { console.log('[SSE] 客户端已断开, 跳过响应'); return; }
            sendAnswer(res, messageId, agentId, `EasyAR 服务连接失败: ${e.message}`);
            sendToolCall(res, messageId, agentId, { command: 'take_photo' });
            sendSSEDone(res, messageId, agentId);
            return;
        }

        if (clientGone) { stopKeepAlive(); console.log('[SSE] 客户端已断开, 跳过识别'); return; }

        // 3. 调用 EasyAR 云识别
        console.log('[识别] 调用 EasyAR 云识别...');
        let result;
        try {
            result = await recognize(
                EASYAR_CLIENT_END_URL,
                tokenResult.token,
                tokenResult.crsAppId || EASYAR_CRS_APPID,
                imageBase64
            );
            console.log(`[计时] EasyAR识别: ${Date.now() - reqStartMs}ms`);
        } catch (e) {
            stopKeepAlive();
            if (clientGone) { console.log('[SSE] 客户端已断开, 跳过响应'); return; }
            sendAnswer(res, messageId, agentId, `识别请求失败: ${e.message}`);
            sendToolCall(res, messageId, agentId, { command: 'take_photo' });
            sendSSEDone(res, messageId, agentId);
            return;
        }

        stopKeepAlive();
        if (clientGone) { console.log('[SSE] 客户端已断开, 跳过响应'); return; }

        // 4. 处理识别结果
        if (!result || !result.target) {
            sendAnswer(res, messageId, agentId, '未识别到匹配的目标，请对准标识物重新拍照。');
            sendToolCall(res, messageId, agentId, {
                command: 'take_photo',
            });
            sendSSEDone(res, messageId, agentId);
            console.log(`[计时] 总耗时: ${Date.now() - reqStartMs}ms (未识别)`);
            return;
        }

        resetRetry(userId);
        const target = result.target;
        console.log(`[识别] 识别到目标: ${target.name} (ID: ${target.targetId})`);

        const meta = parseMeta(target.meta);

        if (meta && meta.destination) {
            sendAnswer(res, messageId, agentId, `识别成功: ${target.name}，正在启动导航到 ${meta.destination}...`);
            sendToolCall(res, messageId, agentId, {
                command: 'take_navigation',
                action: 'open',
                poi_name: meta.destination,
                navi_type: meta.navi_type || '1',
            });
        } else {
            const info = meta
                ? `识别到: ${target.name}\n详细信息: ${JSON.stringify(meta, null, 2)}`
                : `识别到: ${target.name}`;
            sendAnswer(res, messageId, agentId, info);
            sendToolCall(res, messageId, agentId, { command: 'take_photo' });
        }

        sendSSEDone(res, messageId, agentId);
        console.log(`[计时] 总耗时: ${Date.now() - reqStartMs}ms (完成)`);

    } catch (e) {
        stopKeepAlive();
        console.error('[错误]', e);
        try {
            if (!clientGone) {
                sendAnswer(res, messageId, agentId, `服务异常: ${e.message}`);
                sendToolCall(res, messageId, agentId, { command: 'take_photo' });
                sendSSEDone(res, messageId, agentId);
            }
        } catch (_) {
            // 连接可能已断开
        }
    }
});

// 未匹配路由 catch-all
app.use((req, res) => {
    console.warn(`[路由] 未匹配: ${req.method} ${req.url}`);
    res.status(404).json({ error: `未知路由: ${req.method} ${req.url}` });
});

// ─── 获取本机 IP ────────────────────────────────────────────────

function getLocalIP() {
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '0.0.0.0';
}

// ─── 启动服务 ──────────────────────────────────────────────────

app.listen(LINGZHU_PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    const ssePathLocal = `http://${localIP}:${LINGZHU_PORT}/metis/agent/api/sse`;
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════════════╗');
    console.log('║             EasyAR + 灵珠 AR 导航服务 已启动                          ║');
    console.log('╠═══════════════════════════════════════════════════════════════════════╣');
    console.log(`║  监听地址:  0.0.0.0:${LINGZHU_PORT}`.padEnd(72) + '║');
    console.log(`║  本机 IP:   ${localIP}`.padEnd(72) + '║');
    console.log(`║  SSE 端点:  ${ssePathLocal}`.padEnd(72) + '║');
    console.log(`║  鉴权 AK:   ${LINGZHU_AUTH_AK}`.padEnd(72) + '║');
    console.log(`║  强制拍照:  ${LINGZHU_FORCE_TAKE_PHOTO ? '开启' : '关闭'}`.padEnd(72) + '║');
    console.log(`║  最大重试:  ${LINGZHU_MAX_RETRIES} 次`.padEnd(72) + '║');
    console.log(`║  EasyAR:    ${EASYAR_CLIENT_END_URL || '(未配置)'}`.padEnd(72) + '║');
    console.log('╠═══════════════════════════════════════════════════════════════════════╣');
    console.log('║  提交到灵珠平台:                                                      ║');
    console.log(`║    SSE 接口: ${ssePathLocal}`.padEnd(72) + '║');
    console.log(`║    鉴权 AK:  ${LINGZHU_AUTH_AK}`.padEnd(72) + '║');
    console.log('║  (若服务器有独立公网 IP，上面显示的 IP 即可直接使用)'.padEnd(68) + '║');
    console.log('╚═══════════════════════════════════════════════════════════════════════╝');
    console.log('');

    // 预加载 EasyAR token + 预热 HTTPS 连接池
    ensureToken().then(async (tk) => {
        console.log('[启动] EasyAR token 预加载成功');
        if (EASYAR_CLIENT_END_URL) {
            try {
                const dummyBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP///wAAAf/bAEMA//8A/9k=';
                await recognize(EASYAR_CLIENT_END_URL, tk.token, tk.crsAppId || EASYAR_CRS_APPID, dummyBase64);
            } catch (_) {
                // 预热请求失败是正常的（空白图不会被识别），目的只是建立连接
            }
            console.log('[启动] EasyAR HTTPS 连接预热完成');
        }
    }).catch((e) => {
        console.warn(`[启动] EasyAR 预加载失败: ${e.message}（首次请求时会重试）`);
    });

});
