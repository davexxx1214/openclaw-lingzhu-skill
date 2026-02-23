# EasyAR + 灵珠 AR 导航 SSE 服务

通过 EasyAR 云识别 + Rokid 灵珠平台，实现 AR 眼镜拍照识别→自动导航。

## 目录结构

```
openclaw-lingzhu-skill/
└── EasyAR-WebAR-Demo/
    ├── config/
    │   └── application.txt        # 配置文件（EasyAR 密钥 + 灵珠参数）
    ├── EasyAR-WebAR_linux          # EasyAR WebAR 服务（Linux）
    ├── EasyAR-WebAR_windows.exe    # EasyAR WebAR 服务（Windows）
    └── lingzhu-server/
        ├── server.js               # 灵珠 SSE 服务主程序
        ├── easyar-client.js        # EasyAR 云识别客户端（含 webp→jpeg 转码）
        └── package.json
```

## 快速开始

以下所有命令均在 **Linux 服务器** 上执行。假设项目根目录为 `~/openclaw-lingzhu-skill`。

### 第 1 步：编辑配置文件

```bash
cd ~/openclaw-lingzhu-skill/EasyAR-WebAR-Demo
vi config/application.txt
```

确保以下字段已正确填写：

```json
{
    "web": {
        "port": ":3000"
    },
    "cloud": {
        "apiKey": "你的 EasyAR API Key",
        "apiSecret": "你的 API Secret",
        "crsAppId": "你的 CRS AppId",
        "clientEndUrl": "你的 Client-end URL"
    },
    "lingzhu": {
        "port": 18789,
        "authAk": "改成你自己的密钥",
        "forceTakePhoto": true,
        "maxRetries": 3
    }
}
```

#### 配置项说明

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `lingzhu.port` | SSE 服务监听端口 | `18789` |
| `lingzhu.authAk` | 鉴权密钥，需与灵珠平台填写的一致 | 随机生成 |
| `lingzhu.forceTakePhoto` | 用户说任何话都自动触发拍照（无需说"拍照"等关键词） | `false` |
| `lingzhu.maxRetries` | 连续识别失败最大重试次数，超出后停止自动拍照 | `3` |

### 第 2 步：在 EasyAR 云识别库中上传识别图

登录 [EasyAR 控制台](https://www.easyar.cn)，在云识别库中上传识别图。

上传时，在 **meta** 字段填入 Base64 编码的导航 JSON：

```json
{"destination": "杭州西湖", "navi_type": "1", "description": "前往西湖景区"}
```

| navi_type | 含义 |
|-----------|------|
| `0`       | 驾车 |
| `1`       | 步行 |
| `2`       | 骑行 |

### 第 3 步：启动 EasyAR WebAR 服务

EasyAR WebAR 服务用于生成 token，必须先于灵珠服务启动。

```bash
cd ~/openclaw-lingzhu-skill/EasyAR-WebAR-Demo

# Linux：添加执行权限并启动（首次需要）
chmod +x EasyAR-WebAR_linux
./EasyAR-WebAR_linux
```

启动后保持终端运行，**另开一个终端**继续下一步。

> Windows 用户双击运行 `EasyAR-WebAR_windows.exe` 即可。

### 第 4 步：安装依赖并启动灵珠服务

在新终端中执行：

```bash
cd ~/openclaw-lingzhu-skill/EasyAR-WebAR-Demo/lingzhu-server

# 安装 Node.js 依赖（仅首次需要）
npm install

# 启动灵珠 SSE 服务
npm start
```

启动成功后，终端会显示：
- **本机 IP** 和 **SSE 端点地址**（自动检测）
- **鉴权 AK**、**强制拍照**、**最大重试** 等配置状态

### 第 5 步：提交到灵珠平台

在 [灵珠开发平台](https://agent-develop.rokid.com) 创建自定义智能体，填入：

- **SSE 接口地址**: 启动日志中显示的 SSE 端点地址，例如 `http://你的公网IP:18789/metis/agent/api/sse`
- **鉴权 AK**: 启动日志中显示的 AK 值

> 如果服务器在内网/NAT 后面，需要确保公网 IP 的 18789 端口可以被外部访问（检查防火墙/安全组规则）。

## 处理流程

### 整体架构

```
Rokid 眼镜
    ↓ 语音/拍照
灵珠平台 (ReactorNetty)
    ↓ POST /metis/agent/api/sse (SSE)
本服务 (server.js)
    ├─ 无图片 → 触发 take_photo → 眼镜打开相机
    └─ 有图片 → 下载图片 → webp转jpeg → EasyAR 云识别
                  ├─ 识别成功 → take_navigation → 眼镜启动导航
                  └─ 识别失败 → 重试/提示用户
```

### 无图片请求（用户语音触发）

```
用户说话 → 灵珠平台发送文字请求 → 服务端处理
                                      │
          ┌───────────────────────────┘
          │
    forceTakePhoto=true？
    ├─ 是 → 回复"收到，正在为你打开拍照识别。" + take_photo
    └─ 否 → 文字包含"拍照/识别/扫一扫"等关键词？
              ├─ 是 → 回复文字 + take_photo
              └─ 否 → 回复"请拍照后发送图片..."
```

用户发送文字（无图片）时，会重置该用户的重试计数器。

### 图片识别请求（含心跳保活）

图片处理涉及多个耗时步骤（下载、转码、API 调用），为防止连接超时，服务端采用**立即响应 + 心跳保活**机制：

```
灵珠平台 POST 图片请求
    │
    ├─ [0ms]     立即发送 answer："正在识别图片，请稍候..."
    ├─ [0ms]     启动心跳定时器（每 1.5s 发送 SSE comment）
    │
    ├─ [~1s]     下载图片 + webp→jpeg 转码（sharp 库）
    ├─ [~1.5s]   ← 心跳: ": heartbeat 1708xxx"
    ├─ [~1.5s]   获取 EasyAR token（首次从本地服务获取，后续使用缓存）
    ├─ [~2s]     调用 EasyAR 云识别 API
    ├─ [~3s]     ← 心跳: ": heartbeat 1708xxx"
    │
    ├─ 停止心跳定时器
    │
    └─ 处理识别结果（见下方）
```

**心跳格式**：SSE 注释 `: heartbeat <timestamp>\n\n`，符合 SSE 规范，客户端会忽略注释内容但保持连接活跃。

**客户端断开检测**：服务端监听 `res.on('close')` 事件，若客户端在处理期间断开连接（`res.writableFinished === false`），则跳过后续处理和 EasyAR API 调用，避免浪费资源。

**网络优化**：禁用 Nagle 算法（`socket.setNoDelay(true)`），SSE 数据写入后立即推送到网络，不等待缓冲区填满。

### 识别成功

```
EasyAR 返回匹配目标
    │
    ├─ 有导航目标（meta.destination 存在）
    │     ├─ answer: "识别成功: xxx，正在启动导航到 xxx..."
    │     └─ tool_call: take_navigation { poi_name, navi_type }
    │           → 眼镜启动地图导航
    │
    └─ 无导航目标（仅识别到图像，meta 中无 destination）
          ├─ answer: "识别到: xxx" + 详细信息
          └─ tool_call: take_photo（重新拍照）
    │
    └─ event:done → 结束 SSE 流
```

识别成功后，用户的重试计数器会被重置。

### 识别失败（重试机制）

按 `user_id` 跟踪每个用户的连续识别失败次数（5 分钟无操作自动过期）：

```
EasyAR 未匹配到目标
    │
    ├─ 已用次数 < maxRetries（默认 3）
    │     ├─ answer: "未识别到匹配的目标，请对准标识物重新拍照。(剩余N次机会)"
    │     ├─ tool_call: take_photo → 自动打开相机重试
    │     └─ event:done
    │
    └─ 已用次数 = maxRetries
          ├─ answer: "多次识别未成功，请确认标识物是否正确后重新唤起助手再试。"
          ├─ 重置计数器
          ├─ 不发送 take_photo（停止自动拍照循环）
          └─ event:done
```

### 异常处理

所有异常（图片下载失败、EasyAR 服务不可用、识别请求超时等）统一处理：

```
捕获异常
    │
    ├─ 客户端已断开？→ 跳过，仅打印日志
    │
    └─ 客户端在线
          ├─ answer: 具体错误信息（如"图片下载失败: ..."）
          ├─ tool_call: take_photo（让用户重试）
          └─ event:done
```

## SSE 协议格式

### answer 消息（文字回复）

```
event:message
data:{"role":"agent","type":"answer","answer_stream":"文字内容","message_id":"xxx","agent_id":"xxx","is_finish":false}
```

### tool_call 消息（设备命令）

```
event:message
data:{"role":"agent","type":"tool_call","tool_call":{"command":"take_navigation","action":"open","poi_name":"杭州西湖","navi_type":"1"},"message_id":"xxx","agent_id":"xxx","is_finish":true}
```

支持的 tool_call 命令：

| 命令 | 说明 | 参数 |
|------|------|------|
| `take_photo` | 打开相机拍照 | 无 |
| `take_navigation` | 启动地图导航 | `poi_name`, `navi_type`, `action` |

### done 消息（流结束）

```
event:done
data:{"role":"agent","type":"answer","answer_stream":"","message_id":"xxx","agent_id":"xxx","is_finish":true}
```

## 测试

```bash
# 健康检查
curl http://localhost:18789/health

# 模拟文字请求（触发拍照）
curl -X POST http://localhost:18789/metis/agent/api/sse \
  -H "Authorization: Bearer 你的authAk值" \
  -H "Content-Type: application/json" \
  -d '{"message_id":"test01","agent_id":"main","user_id":"testuser","message":[{"role":"user","type":"text","text":"识别导航"}]}'

# 模拟图片识别请求
curl -X POST http://localhost:18789/metis/agent/api/sse \
  -H "Authorization: Bearer 你的authAk值" \
  -H "Content-Type: application/json" \
  -d '{"message_id":"test02","agent_id":"main","user_id":"testuser","message":[{"role":"user","type":"image","image_url":"https://example.com/test.jpg"}]}'
```

## 日志说明

服务运行时会输出详细日志，方便排查问题：

| 日志前缀 | 含义 |
|----------|------|
| `[URL清理]` | 请求 URL 中的尾部空格/斜杠被自动修正 |
| `[鉴权]` | 鉴权结果（通过/失败） |
| `[SSE] >>` | 发送给客户端的 SSE 事件 |
| `[SSE] ⚠` | 客户端断开连接（含断开时间点） |
| `[识别]` | EasyAR 图片识别流程 |
| `[图片]` | 图片下载和转码详情 |
| `[计时]` | 各处理步骤耗时（毫秒） |
| `[重试]` | 用户连续失败次数和上限 |
| `[Token]` | EasyAR token 获取/缓存状态 |

## 常见问题

**Q: 启动时提示 "无法读取 config/application.txt"**
A: 确认你是在 `lingzhu-server/` 目录下运行的 `npm start`，配置文件路径是相对于 `lingzhu-server/` 上级目录的 `config/application.txt`。

**Q: 启动时提示 "无法获取 EasyAR token"**
A: 确认 EasyAR WebAR 服务（第 3 步）已在运行。

**Q: 灵珠平台无法连接到 SSE 接口**
A: 检查服务器防火墙是否开放了 18789 端口，云服务器还需检查安全组规则。

**Q: 眼镜端显示 "AI助手异常请重试"**
A: 通常是 SSE 响应格式问题。检查服务端日志确认 `event:done` 是否正常发送。服务端的 done 事件使用 JSON 格式（非 `[DONE]` 纯文本），已适配 Rokid 客户端。

**Q: 拍照后眼镜应用退出，没有收到识别结果**
A: 图片处理耗时较长时连接可能超时。服务端已内置心跳保活机制（每 1.5s），检查日志中是否有 `heartbeat` 记录。若日志显示 `⚠ 客户端断开连接`，说明平台侧超时过短。

**Q: EasyAR 识别总是失败（statusCode 30）**
A: Rokid 眼镜拍摄的图片为 webp 格式，EasyAR 对 webp 兼容较差。服务端已内置 `sharp` 库自动将 webp 转为 jpeg，确认 `npm install` 时 sharp 安装成功（日志中应有 `webp -> jpeg 转码成功`）。
