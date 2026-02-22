---
name: lingzhu
description: 通过灵珠平台将 OpenClaw 接入 Rokid Glasses，支持拍照传图、图片理解、导航、日程工具，并同步眼镜设备信息。灵珠平台地址 https://agent-develop.rokid.com
metadata: {"openclaw":{"emoji":"🔗","requires":{"plugins":["lingzhu"],"config":["gateway.http.endpoints.chatCompletions.enabled"]},"install":[{"kind":"node","package":"@r.wmi/openclaw-lingzhu"}]}}
---

## 支持的设备命令

| 灵珠命令 | OpenClaw 工具名 | 说明 |
| :--- | :--- | :--- |
| `take_photo` | take_photo, camera, photo | 拍照 |
| `take_navigation` | navigate, navigation, maps | 导航 |
| `control_calendar` | calendar, schedule, reminder | 日程 |
| `notify_agent_off` | exit, quit | 退出智能体 |

## 图片理解能力

- 默认使用 `visionMode=passthrough` 多模态透传，图片可直接发送给 OpenClaw 视觉模型分析。
- 若运行环境不支持多模态，可切换 `visionMode=legacy_text_embed` 作为兼容模式。
- `take_photo` 后，灵珠上行的图片消息会继续走同一多模态链路用于图像理解。

## 插件的集成引导

当用户需要接入灵珠平台时，请阅读 `references/install.md` 并按照其中的步骤执行。
