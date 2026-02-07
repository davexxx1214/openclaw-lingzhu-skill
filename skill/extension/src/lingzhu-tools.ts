/**
 * 灵珠设备工具定义
 * 这些工具会被注册到 OpenClaw Agent，当 AI 调用时会转换为灵珠设备命令
 */

// 拍照工具参数
const TakePhotoParams = {
    type: "object",
    properties: {},
    required: []
};

// 导航工具参数
const NavigateParams = {
    type: "object",
    properties: {
        destination: { type: "string", description: "目标地址或 POI 名称" },
        navi_type: {
            type: "string",
            enum: ["0", "1", "2"],
            description: "导航类型：0=驾车，1=步行，2=骑行"
        },
    },
    required: ["destination"],
};

// 日程工具参数
const CalendarParams = {
    type: "object",
    properties: {
        title: { type: "string", description: "日程标题" },
        start_time: { type: "string", description: "开始时间，格式：YYYY-MM-DD HH:mm" },
        end_time: { type: "string", description: "结束时间，格式：YYYY-MM-DD HH:mm" },
    },
    required: ["title", "start_time"],
};

/**
 * 创建灵珠设备工具
 * 这些工具由灵珠设备端执行，OpenClaw 仅负责转换协议
 */
export function createLingzhuTools() {
    return [
        {
            name: "take_photo",
            description: "使用灵珠设备的摄像头拍照。当用户要求拍照、拍摄、照相时，调用此工具。",
            parameters: TakePhotoParams,
            async execute(_id: string, _params: any) {
                // 返回特殊标记，让 http-handler 识别并生成 tool_call
                return {
                    content: [
                        {
                            type: "text",
                            text: `<LINGZHU_TOOL_CALL:take_photo:{}> 正在通过灵珠设备拍照...`,
                        },
                    ],
                };
            },
        },
        {
            name: "navigate",
            description: "使用灵珠设备的导航功能，导航到指定地址或POI。",
            parameters: NavigateParams,
            async execute(_id: string, params: any) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `<LINGZHU_TOOL_CALL:take_navigation:${JSON.stringify(params)}> 正在导航到 ${params.destination}...`,
                        },
                    ],
                };
            },
        },
        {
            name: "calendar",
            description: "在灵珠设备上创建日程提醒。",
            parameters: CalendarParams,
            async execute(_id: string, params: any) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `<LINGZHU_TOOL_CALL:control_calendar:${JSON.stringify(params)}> 已创建日程: ${params.title}`,
                        },
                    ],
                };
            },
        },
        {
            name: "exit_agent",
            description: "退出当前智能体会话，返回灵珠主界面。",
            parameters: { type: "object", properties: {} },
            async execute() {
                return {
                    content: [
                        {
                            type: "text",
                            text: `<LINGZHU_TOOL_CALL:notify_agent_off:{}> 正在退出智能体...`,
                        },
                    ],
                };
            },
        },
    ];
}
