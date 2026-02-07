/**
 * 灵珠插件配置类型
 */
export interface LingzhuConfig {
  enabled?: boolean;
  authAk?: string;
  agentId?: string;
  /** 是否将设备信息（metadata）传递给 OpenClaw，默认 true */
  includeMetadata?: boolean;
}

/**
 * 灵珠请求消息格式
 */
export interface LingzhuMessage {
  role: "user" | "agent";
  type: "text" | "image";
  text?: string;
  image_url?: string;
}

/**
 * 灵珠请求上下文
 */
export interface LingzhuContext {
  location?: string;
  latitude?: string;
  longitude?: string;
  weather?: string;
  battery?: string;
  currentTime?: string;
  lang?: string;
  company_id?: number;
  runningApp?: string;
}

/**
 * 灵珠请求体
 */
export interface LingzhuRequest {
  message_id: string;
  agent_id: string;
  message: LingzhuMessage[];
  user_id?: string;
  /** metadata 直接包含设备上下文信息（非嵌套在 context 下） */
  metadata?: LingzhuContext;
}

/**
 * 灵珠工具调用
 */
export interface LingzhuToolCall {
  handling_required: boolean;
  command: "take_photo" | "take_navigation" | "notify_agent_off" | "control_calendar";
  params: {
    is_recall?: boolean;
    action?: string;
    poi_name?: string;
    navi_type?: string;
    title?: string;
    start_time?: string;
    end_time?: string;
  };
}

/**
 * 灵珠 SSE 响应数据
 */
export interface LingzhuSSEData {
  role: "agent";
  type: "answer" | "tool_call" | "follow_up";
  answer_stream?: string;
  message_id: string;
  agent_id: string;
  is_finish: boolean;
  follow_up?: string[];
  tool_call?: LingzhuToolCall;
}
