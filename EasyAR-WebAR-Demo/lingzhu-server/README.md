# EasyAR + 灵珠 AR 导航 SSE 服务

通过 EasyAR 云识别 + Rokid 灵珠平台，实现 AR 眼镜拍照识别→自动导航。

## 目录结构

```
openclaw-lingzhu-skill/
└── EasyAR-WebAR-Demo/
    ├── config/
    │   └── application.txt        # 配置文件（EasyAR 密钥 + 灵珠端口）
    ├── EasyAR-WebAR_linux          # EasyAR WebAR 服务（Linux）
    ├── EasyAR-WebAR_windows.exe    # EasyAR WebAR 服务（Windows）
    └── lingzhu-server/
        ├── server.js               # 灵珠 SSE 服务主程序
        ├── easyar-client.js        # EasyAR 云识别客户端
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
        "authAk": "改成你自己的密钥"
    }
}
```

> **注意**: `lingzhu.authAk` 请务必修改为自己的密钥，不要使用默认值。

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
- **鉴权 AK**

### 第 5 步：提交到灵珠平台

在 [灵珠开发平台](https://agent-develop.rokid.com) 创建自定义智能体，填入：

- **SSE 接口地址**: 启动日志中显示的 SSE 端点地址，例如 `http://你的公网IP:18789/metis/agent/api/sse`
- **鉴权 AK**: 启动日志中显示的 AK 值

> 如果服务器在内网/NAT 后面，需要确保公网 IP 的 18789 端口可以被外部访问（检查防火墙/安全组规则）。

## 测试

```bash
# 健康检查（在服务器上执行）
curl http://localhost:18789/health

# 模拟灵珠发送图片识别请求
curl -X POST http://localhost:18789/metis/agent/api/sse \
  -H "Authorization: Bearer 你的authAk值" \
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

## 常见问题

**Q: 启动时提示 "无法读取 config/application.txt"**
A: 确认你是在 `lingzhu-server/` 目录下运行的 `npm start`，配置文件路径是相对于 `lingzhu-server/` 上级目录的 `config/application.txt`。

**Q: 启动时提示 "无法获取 EasyAR token"**
A: 确认 EasyAR WebAR 服务（第 3 步）已在运行。

**Q: 灵珠平台无法连接到 SSE 接口**
A: 检查服务器防火墙是否开放了 18789 端口，云服务器还需检查安全组规则。
