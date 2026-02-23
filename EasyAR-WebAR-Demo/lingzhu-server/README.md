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
        ├── easyar-client.js        # EasyAR 云识别客户端（含 webp→jpeg 转码、连接复用）
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
本服务 (server.js + easyar-client.js)
    ├─ 无图片 → 触发 take_photo → 眼镜打开相机
    └─ 有图片 → 下载图片 → webp转jpeg → EasyAR 云识别
                  ├─ 识别成功 → take_navigation → 眼镜启动导航
                  └─ 识别失败 → take_photo 重试（最多 N 次）
```

### 启动预热

服务启动时执行三项预热操作，确保首次请求的响应速度：

```
服务启动
    ├─ 1. EasyAR Token 预加载
    │     └─ 从本地 EasyAR WebAR 服务获取 token 并缓存（约 22 小时有效）
    ├─ 2. EasyAR API 连接预热
    │     └─ 发送一个 dummy 识别请求，建立到 EasyAR 服务的 HTTPS 连接池
    └─ 3. Rokid CDN 连接预热
          └─ 向 basecloud.rokidcdn.com 发起 HTTPS 请求，建立 TLS 连接池
```

预热后，后续的图片下载和 API 调用可以复用已有的 TCP/TLS 连接（HTTP keepAlive），避免跨地域 TLS 握手的额外耗时（200-500ms/次）。

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

### 图片识别请求（静默处理）

图片处理分支**不发送任何初始消息或心跳**，在全部处理完成后一次性返回结果。

这是因为 Rokid 平台有一个关键限制：**如果先发送 answer 事件（`is_finish:false`）或 SSE 注释，平台会进入"文本回复"模式，后续的 `tool_call`（如 `take_navigation`）会被忽略**。因此必须保证 SSE 流中的第一条事件就是最终结果。

```
灵珠平台 POST 图片请求
    │
    ├─ 设置 SSE 响应头 + flushHeaders()
    │  （建立 SSE 连接，但不发送任何事件数据）
    │
    ├─ [~500ms]  下载图片（复用 keepAlive 连接到 rokidcdn.com）
    ├─ [~600ms]  webp → jpeg 转码 + 缩放（sharp: max 800px, quality 60）
    ├─ [~600ms]  获取 EasyAR token（从缓存读取，约 0ms）
    ├─ [~1.5s]   调用 EasyAR 云识别 API（复用 keepAlive 连接）
    │
    └─ 一次性发送结果（answer + tool_call + done）
```

典型耗时约 1.5-2.5 秒，依赖 keepAlive 连接复用和图片压缩来控制在 Rokid 平台的超时窗口内。

### 识别成功

```
EasyAR 返回匹配目标
    │
    ├─ 有导航目标（meta.destination 存在）
    │     ├─ answer: "识别成功: xxx，正在启动导航到 xxx..."（is_finish:false）
    │     ├─ tool_call: take_navigation { poi_name, navi_type }（is_finish:true）
    │     └─ done → 眼镜启动地图导航
    │
    └─ 无导航目标（仅识别到图像，meta 中无 destination）
          ├─ answer: "识别到: xxx" + 详细信息
          ├─ tool_call: take_photo（重新拍照）
          └─ done
```

识别成功后，用户的重试计数器会被重置。

### 识别失败（自动重试）

识别失败时，服务端发送 `take_photo` 命令让眼镜自动重新拍照。Rokid 平台会再次发来新的图片请求，形成重试循环：

```
第 1 次：拍照 → 图片发到服务端 → 识别失败
    ├─ answer: "未识别到匹配的目标，请对准标识物重新拍照。"
    ├─ tool_call: take_photo → 眼镜自动拍照
    └─ done

第 2 次：拍照 → 图片发到服务端 → 识别失败
    ├─ answer: "未识别到匹配的目标，请对准标识物重新拍照。"
    ├─ tool_call: take_photo → 眼镜自动拍照
    └─ done

第 3 次：拍照 → 图片发到服务端 → 识别失败
    ├─ answer: "未识别到匹配的目标，请对准标识物重新拍照。"
    ├─ tool_call: take_photo → 继续重试...
    └─ done

...直到识别成功或达到 maxRetries 上限
```

重试计数按 `user_id` 跟踪，5 分钟无操作自动过期。当前版本中 `take_photo` 会持续发送以触发重试循环。

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
          └─ done
```

### 客户端断开检测

服务端监听 `res.on('close')` 事件（而非 `req.on('close')`，后者在请求体读完就触发，是假阳性）。若在处理期间检测到 `res.writableFinished === false`，说明客户端真正断开，跳过后续处理以避免浪费资源。

## 性能优化

服务端通过多项优化确保图片处理在 Rokid 平台超时窗口（约 2-3 秒）内完成：

| 优化项 | 说明 | 效果 |
|--------|------|------|
| **HTTP keepAlive 连接复用** | `easyar-client.js` 中为 HTTPS/HTTP 请求配置 `keepAlive: true` Agent，复用已建立的 TCP/TLS 连接 | 省去每次请求的 TLS 握手（200-500ms） |
| **启动预热** | 服务启动时预热 EasyAR API 和 Rokid CDN 连接 | 首次请求也能复用连接 |
| **图片压缩** | 使用 sharp 将所有图片统一缩放到 max 800px、JPEG quality 60 | 原始 ~90KB webp → ~50KB jpeg，加速上传和识别 |
| **Token 缓存** | EasyAR token 缓存约 22 小时，避免重复获取 | 省去 token 请求耗时 |
| **Nagle 算法禁用** | `socket.setNoDelay(true)` | SSE 数据立即推送，不等缓冲区填满 |
| **静默处理** | 图片分支不发送初始 answer 或心跳 | 避免 Rokid 平台忽略后续 tool_call |

## SSE 协议格式

### answer 消息（文字回复）

```
event:message
data:{"role":"agent","type":"answer","answer_stream":"文字内容","message_id":"xxx","agent_id":"xxx","is_finish":false}
```

- `is_finish:false` 表示后续还有事件
- `is_finish:true` 表示这是最后一条 answer

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

> 注意：done 事件使用 JSON 格式（非 `data:[DONE]` 纯文本），因为 Rokid 客户端对纯文本 `[DONE]` 兼容较差。

### 重要约束：图片分支的事件顺序

Rokid 平台对 SSE 事件顺序有严格限制。图片识别分支中，**answer 和 tool_call 必须在同一时刻连续发送**：

```
✅ 正确（导航能触发）：
  answer("识别成功...", is_finish:false)   ← 第一条事件
  tool_call(take_navigation, is_finish:true) ← 紧跟其后
  done

❌ 错误（导航被忽略）：
  answer("正在识别...", is_finish:false)    ← 先发了一条 answer
  ... 等待 2 秒 ...
  answer("识别成功...", is_finish:false)    ← 第二条 answer
  tool_call(take_navigation, is_finish:true) ← 被平台忽略
  done
```

原因：Rokid 平台收到第一条 answer 后进入"文本回复"模式，后续的 tool_call 不再被执行。因此图片处理分支必须等所有处理完成后，一次性发送结果。

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
| `[SSE] >>` | 发送给客户端的 SSE 事件内容 |
| `[SSE] ⚠` | 客户端断开连接（含断开时间点） |
| `[识别]` | EasyAR 图片识别流程（下载、识别、结果） |
| `[图片]` | 图片下载和转码详情（格式、大小） |
| `[计时]` | 各处理步骤耗时（毫秒），用于性能分析 |
| `[重试]` | 用户连续失败次数和上限 |
| `[Token]` | EasyAR token 获取/缓存状态 |
| `[启动]` | 服务启动阶段的预热状态 |

## 常见问题

**Q: 启动时提示 "无法读取 config/application.txt"**
A: 确认你是在 `lingzhu-server/` 目录下运行的 `npm start`，配置文件路径是相对于 `lingzhu-server/` 上级目录的 `config/application.txt`。

**Q: 启动时提示 "无法获取 EasyAR token"**
A: 确认 EasyAR WebAR 服务（第 3 步）已在运行。

**Q: 灵珠平台无法连接到 SSE 接口**
A: 检查服务器防火墙是否开放了 18789 端口，云服务器还需检查安全组规则。

**Q: 眼镜端显示 "AI助手异常请重试"**
A: 通常是 SSE 响应格式问题。检查服务端日志确认 `event:done` 是否正常发送。服务端的 done 事件使用 JSON 格式（非 `[DONE]` 纯文本），已适配 Rokid 客户端。

**Q: 识别成功但导航没有启动**
A: 检查服务端日志中的 `[计时] 总耗时`。如果超过 2-3 秒，Rokid 平台可能已超时断开。优化方向：确认 keepAlive 连接复用正常工作（启动日志应显示"CDN 连接预热完成"和"EasyAR HTTPS 连接预热完成"）、将服务器部署在靠近 Rokid CDN 的地域。

**Q: 拍照后眼镜应用退出，没有收到识别结果**
A: 图片处理耗时超出平台超时窗口。检查日志中 `[计时]` 各步骤耗时，关注图片下载时间。如果图片下载经常超过 1 秒，说明服务器到 Rokid CDN 的网络延迟较高，建议将服务部署在国内。

**Q: EasyAR 识别总是失败（statusCode 30）**
A: Rokid 眼镜拍摄的图片为 webp 格式，EasyAR 对 webp 兼容较差。服务端已内置 `sharp` 库自动将 webp 转为 jpeg，确认 `npm install` 时 sharp 安装成功（日志中应有 `转码+缩放完成`）。
