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

// ─── SSE 响应工具函数 ──────────────────────────────────────────

function sendSSE(res, data) {
    res.write(`event:message\ndata:${JSON.stringify(data)}\n\n`);
}

function sendSSEDone(res) {
    res.write(`event:done\ndata:[DONE]\n\n`);
    res.end();
}

function sendAnswer(res, messageId, text, isFinish = false) {
    sendSSE(res, {
        role: 'agent',
        type: 'answer',
        answer_stream: text,
        message_id: messageId,
        agent_id: 'easyar-navi',
        is_finish: isFinish,
    });
}

function sendToolCall(res, messageId, command, params) {
    sendSSE(res, {
        role: 'agent',
        type: 'tool_call',
        tool_call: {
            handling_required: true,
            command: command,
            params: params,
        },
        message_id: messageId,
        agent_id: 'easyar-navi',
        is_finish: true,
    });
}

// ─── Express 应用 ──────────────────────────────────────────────

const app = express();

// 请求日志中间件 —— 所有请求都会打印
app.use((req, res, next) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] --> ${req.method} ${req.url} from ${req.ip}`);
    console.log(`[${ts}]     Headers: ${JSON.stringify(req.headers)}`);
    res.on('finish', () => {
        console.log(`[${ts}] <-- ${req.method} ${req.url} ${res.statusCode}`);
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

    const { message_id, message, metadata } = req.body;
    const messageId = message_id || crypto.randomUUID();

    // 设置 SSE 响应头
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // nginx 代理时禁用缓冲
    });

    try {
        // 提取图片和文本
        const messages = message || [];
        let imageUrl = null;
        let userText = '';

        for (const msg of messages) {
            if (msg.type === 'image' && msg.image_url) {
                imageUrl = msg.image_url;
            }
            if (msg.type === 'text' && msg.text) {
                userText += msg.text + ' ';
            }
        }

        // 如果没有图片，返回文字提示
        if (!imageUrl) {
            sendAnswer(res, messageId, '请拍照后发送图片，我会识别并导航到对应地点。', true);
            sendSSEDone(res);
            return;
        }

        // 1. 发送"正在识别"状态
        sendAnswer(res, messageId, '📷 正在识别图片...');

        // 2. 下载图片并转 Base64
        console.log(`[识别] 下载图片: ${imageUrl}`);
        let imageBase64;
        try {
            imageBase64 = await downloadImageAsBase64(imageUrl);
        } catch (e) {
            sendAnswer(res, messageId, `❌ 图片下载失败: ${e.message}`, true);
            sendSSEDone(res);
            return;
        }

        // 3. 获取 token
        let tokenResult;
        try {
            tokenResult = await ensureToken();
        } catch (e) {
            sendAnswer(res, messageId, `❌ EasyAR 服务连接失败: ${e.message}`, true);
            sendSSEDone(res);
            return;
        }

        // 4. 调用 EasyAR 云识别
        console.log('[识别] 调用 EasyAR 云识别...');
        let result;
        try {
            result = await recognize(
                EASYAR_CLIENT_END_URL,
                tokenResult.token,
                tokenResult.crsAppId || EASYAR_CRS_APPID,
                imageBase64
            );
        } catch (e) {
            sendAnswer(res, messageId, `❌ 识别请求失败: ${e.message}`, true);
            sendSSEDone(res);
            return;
        }

        // 5. 处理识别结果
        if (!result || !result.target) {
            sendAnswer(res, messageId, '🔍 未识别到匹配的目标，请对准标识物重新拍照。', true);
            sendSSEDone(res);
            return;
        }

        const target = result.target;
        console.log(`[识别] 识别到目标: ${target.name} (ID: ${target.targetId})`);

        // 6. 解析 meta 中的导航信息
        const meta = parseMeta(target.meta);

        if (meta && meta.destination) {
            // 有导航信息，发送导航命令
            sendAnswer(res, messageId, `✅ 识别成功: ${target.name}，正在启动导航到 ${meta.destination}...`);

            sendToolCall(res, messageId, 'take_navigation', {
                poi_name: meta.destination,
                navi_type: meta.navi_type || '1', // 默认步行
            });
        } else {
            // 没有导航信息，返回识别结果文本
            const info = meta
                ? `识别到: ${target.name}\n详细信息: ${JSON.stringify(meta, null, 2)}`
                : `识别到: ${target.name}`;
            sendAnswer(res, messageId, `✅ ${info}`, true);
        }

        sendSSEDone(res);

    } catch (e) {
        console.error('[错误]', e);
        try {
            sendAnswer(res, messageId, `❌ 服务异常: ${e.message}`, true);
            sendSSEDone(res);
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
    console.log(`║  EasyAR:    ${EASYAR_CLIENT_END_URL || '(未配置)'}`.padEnd(72) + '║');
    console.log('╠═══════════════════════════════════════════════════════════════════════╣');
    console.log('║  提交到灵珠平台:                                                      ║');
    console.log(`║    SSE 接口: ${ssePathLocal}`.padEnd(72) + '║');
    console.log(`║    鉴权 AK:  ${LINGZHU_AUTH_AK}`.padEnd(72) + '║');
    console.log('║  (若服务器有独立公网 IP，上面显示的 IP 即可直接使用)'.padEnd(68) + '║');
    console.log('╚═══════════════════════════════════════════════════════════════════════╝');
    console.log('');
});
