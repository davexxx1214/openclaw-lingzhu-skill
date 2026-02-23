/**
 * EasyAR 云识别 API 客户端
 * 封装 token 生成和图片识别功能
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
let sharp = null;
try {
    sharp = require('sharp');
} catch (_) {
    // 未安装 sharp 时仍可运行，只是无法自动转码
}

// 持久连接池 —— 避免每次请求都做 TLS 握手（省 200-500ms）
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });

/**
 * 从本地 EasyAR 服务获取 token
 */
async function getTokenFromLocal(webarPort = 3000, expire = 86400) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: webarPort,
            path: `/webar/token?expire=${expire}`,
            method: 'POST',
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.statusCode === 0) {
                        resolve(json.result);
                    } else {
                        reject(new Error(`Token 获取失败: ${JSON.stringify(json)}`));
                    }
                } catch (e) {
                    reject(new Error(`Token 响应解析失败: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * 调用 EasyAR 云识别 API
 */
async function recognize(clientEndUrl, token, crsAppId, imageBase64) {
    const url = new URL(`${clientEndUrl}/search`);

    const body = JSON.stringify({
        image: imageBase64,
        appId: crsAppId,
        notracking: true,
    });

    return new Promise((resolve, reject) => {
        const options = {
            hostname: url.hostname,
            port: url.port || 8443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json;Charset=UTF-8',
                'Authorization': token,
            },
            agent: httpsAgent,
            rejectUnauthorized: false,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.statusCode === 0) {
                        resolve(json.result);
                    } else if (json.statusCode === 17) {
                        resolve(null);
                    } else {
                        reject(new Error(`识别请求失败: ${JSON.stringify(json)}`));
                    }
                } catch (e) {
                    reject(new Error(`识别响应解析失败: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * 解析识别结果中的 meta 字段（Base64 编码的 JSON）
 */
function parseMeta(metaBase64) {
    if (!metaBase64) return null;
    try {
        const decoded = Buffer.from(metaBase64, 'base64').toString('utf-8');
        return JSON.parse(decoded);
    } catch (e) {
        console.warn('[EasyAR] meta 解析失败:', e.message);
        return null;
    }
}

/**
 * 下载图片并转 Base64
 */
async function downloadImageAsBase64(imageUrl) {
    return new Promise((resolve, reject) => {
        const isHttps = imageUrl.startsWith('https');
        const protocol = isHttps ? https : http;
        protocol.get(imageUrl, { agent: isHttps ? httpsAgent : httpAgent, rejectUnauthorized: false }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadImageAsBase64(res.headers.location).then(resolve).catch(reject);
            }

            if (res.statusCode !== 200) {
                return reject(new Error(`图片下载失败，HTTP ${res.statusCode}`));
            }

            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', async () => {
                try {
                    let buffer = Buffer.concat(chunks);
                    const contentType = (res.headers['content-type'] || '').toLowerCase();
                    console.log(`[图片] 下载完成: content-type=${contentType || '(unknown)'}, bytes=${buffer.length}`);

                    if (sharp) {
                        buffer = await sharp(buffer)
                            .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
                            .jpeg({ quality: 60 })
                            .toBuffer();
                        console.log(`[图片] 转码+缩放完成 (jpeg q60 max800), bytes=${buffer.length}`);
                    } else if (contentType.includes('image/webp')) {
                        console.warn('[图片] 当前是 webp，且未安装 sharp，可能导致 EasyAR 识别失败');
                    }

                    resolve(buffer.toString('base64'));
                } catch (e) {
                    reject(new Error(`图片处理失败: ${e.message}`));
                }
            });
        }).on('error', reject);
    });
}

module.exports = {
    getTokenFromLocal,
    recognize,
    parseMeta,
    downloadImageAsBase64,
};
