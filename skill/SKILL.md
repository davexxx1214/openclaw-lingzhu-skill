---
name: lingzhu
description: 通过灵珠平台，将 CpenClaw 接入 Rokid Glasses,支持控制拍照传图、导航、日程工具,支持与智能体同步眼镜设备信息,灵珠平台地址 https://agent-develop.rokid.com
metadata: {"openclaw":{"emoji":"🔗","requires":{"plugins":["lingzhu"],"config":["gateway.http.endpoints.chatCompletions.enabled"]},"install":[{"kind":"node","package":"@r.wmi/openclaw-lingzhu"}]}}
---

## 支持的设备命令

| 灵珠命令 | OpenClaw 工具名 | 说明 |
| :--- | :--- | :--- |
| `take_photo` | take_photo, camera, photo | 拍照 |
| `take_navigation` | navigate, navigation, maps | 导航 |
| `control_calendar` | calendar, schedule, reminder | 日程 |
| `notify_agent_off` | exit, quit | 退出智能体 |

## 插件的集成引导

当用户需要接入灵珠平台时，请阅读 `references/install.md` 并按照其中的步骤执行。
