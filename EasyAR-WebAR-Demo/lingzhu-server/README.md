# EasyAR + 灵珠 AR 导航 SSE 服务

通过 EasyAR 云识别 + Rokid 灵珠平台，实现 AR 眼镜拍照识别→自动导航。

## 快速开始

### 1. 配置

编辑 `../config/application.txt`，确保以下字段已填：

```json
{
    "cloud": {
        "apiKey": "你的 EasyAR API Key",
        "apiSecret": "你的 API Secret",
        "crsAppId": "你的 CRS AppId",
        "clientEndUrl": "你的 Client-end URL"
    },
    "lingzhu": {
        "port": 18789,
        "authAk": "自定义鉴权密钥"
    }
}
```

### 2. 在 EasyAR 云识别库中上传识别图

上传识别图时，在 **meta** 字段填入 Base64 编码的导航 JSON：

```json
{"destination": "杭州西湖", "navi_type": "1", "description": "前往西湖景区"}
```

`navi_type`: `0`=驾车，`1`=步行，`2`=骑行

### 3. 安装依赖并启动

```bash
# 先启动 EasyAR WebAR 服务（用于 token 生成）
# Windows:
..\EasyAR-WebAR_windows.exe
# Linux:
../EasyAR-WebAR_linux

# 安装依赖
npm install

# 启动灵珠导航服务
npm start
```

### 4. 提交到灵珠平台

在 [灵珠开发平台](https://agent-develop.rokid.com) 创建自定义智能体,填入：

- **SSE 接口地址**: `http://<公网IP>:18789/metis/agent/api/sse`
- **鉴权 AK**: 启动时显示的 AK 值

## 测试

```bash
# 健康检查
curl http://127.0.0.1:18789/health

# 模拟灵珠发送图片识别
curl -X POST http://127.0.0.1:18789/metis/agent/api/sse \
  -H "Authorization: Bearer your-secret-ak-change-me" \
  -H "Content-Type: application/json" \
  -d '{"message_id":"test01","agent_id":"main","message":[{"role":"user","type":"text","text":"识别导航"},{"role":"user","type":"image","image_url":"https://example.com/test.jpg"}]}'
```

## 架构

```
Rokid 眼镜 → 灵珠平台 → 本服务 (SSE) → EasyAR 云识别
                                   ↓
                            返回 take_navigation 命令
                                   ↓
                          灵珠平台 → Rokid 眼镜启动导航
```
