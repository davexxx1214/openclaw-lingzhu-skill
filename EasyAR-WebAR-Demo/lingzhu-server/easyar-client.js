/**
 * EasyAR 云识别 API 客户端
 * 封装 token 生成和图片识别功能
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

/**
 * 生成 EasyAR Cloud Recognition Token
 * 参考 EasyAR 文档，token = HMAC-SHA256(apiSecret, apiKey)
 * 如果本地 exe 可用，也可以通过 /webar/token 获取
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
 * @param {string} clientEndUrl - Client-end (Target Recognition) URL
 * @param {string} token - 认证 token
 * @param {string} crsAppId - CRS AppId
 * @param {string} imageBase64 - 图片 Base64 编码
 * @returns {Promise<object>} 识别结果
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
            // 允许自签名证书（开发用）
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
                        resolve(null); // 未识别到目标
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
 * @param {string} metaBase64 - Base64 编码的 meta 数据
 * @returns {object|null} 解析后的导航信息
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
 * @param {string} imageUrl - 图片 URL
 * @returns {Promise<string>} Base64 编码的图片
 */
async function downloadImageAsBase64(imageUrl) {
    return new Promise((resolve, reject) => {
        const protocol = imageUrl.startsWith('https') ? https : http;
        protocol.get(imageUrl, { rejectUnauthorized: false }, (res) => {
            // 处理重定向
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadImageAsBase64(res.headers.location).then(resolve).catch(reject);
            }

            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve(buffer.toString('base64'));
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
