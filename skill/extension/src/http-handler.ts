import type { IncomingMessage, ServerResponse } from "node:http";
import type { LingzhuRequest } from "./types.js";
import type { LingzhuConfig } from "./types.js";
import {
  lingzhuToOpenAI,
  openaiChunkToLingzhu,
  formatLingzhuSSE,
  createFollowUpResponse,
  extractFollowUpFromText,
  ToolCallAccumulator,
  parseToolCallFromAccumulated,
  detectIntentFromText,
} from "./transform.js";

/**
 * 验证 Authorization 头
 */
function verifyAuth(
  authHeader: string | string[] | undefined,
  expectedAk: string
): boolean {
  if (!expectedAk) {
    // 未配置 AK 时跳过验证
    return true;
  }

  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header) return false;

  return header === `Bearer ${header.startsWith("Bearer ") ? expectedAk : expectedAk}`; // Normalization check: if it already has Bearer, we just compare
}

/**
 * 读取 JSON 请求体
 */
async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", (e) => reject(e));
  });
}

/**
 * 下载图片到本地临时目录，返回 file:// URL
 */
async function downloadImageToFile(imageUrl: string): Promise<string | null> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const crypto = await import("node:crypto");
  const { fileURLToPath } = await import("node:url");

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type") || "image/webp";
    const ext = contentType.includes("png") ? ".png"
      : contentType.includes("jpeg") || contentType.includes("jpg") ? ".jpg"
        : contentType.includes("gif") ? ".gif"
          : ".webp";

    // 获取当前模块所在目录，创建 .cache/img 目录
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const cacheDir = path.resolve(__dirname, "../../.cache/img");
    await fs.mkdir(cacheDir, { recursive: true });

    // 生成唯一文件名
    const hash = crypto.createHash("md5").update(imageUrl).digest("hex").slice(0, 12);
    const fileName = `img_${Date.now()}_${hash}${ext}`;
    const filePath = path.join(cacheDir, fileName);

    // 保存图片到文件
    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(filePath, Buffer.from(arrayBuffer));

    return `file://${filePath}`;
  } catch {
    return null;
  }
}

/**
 * 预处理 OpenAI 消息：下载图片到本地并将路径嵌入到文本消息中
 * 注意：OpenClaw 的 /v1/chat/completions API 只提取文本内容，忽略 image_url
 * 因此我们将图片路径直接嵌入到文本中
 */
async function preprocessOpenAIMessages(
  messages: Array<{ role: string; content: string | Array<{ type: string; image_url?: { url: string }; text?: string }> }>,
  logger: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<Array<{ role: string; content: string }>> {
  const result: Array<{ role: string; content: string }> = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      result.push({ role: msg.role, content: String(msg.content) });
      continue;
    }

    // 处理多模态消息：收集文本和图片路径
    const textParts: string[] = [];
    const imagePaths: string[] = [];

    for (const part of msg.content) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.type === "image_url" && part.image_url?.url) {
        const url = part.image_url.url;

        // 如果已经是本地文件路径，直接使用
        if (url.startsWith("file://")) {
          imagePaths.push(url.replace("file://", ""));
        } else if (url.startsWith("data:")) {
          // data URL 暂不处理，跳过
          logger.warn(`[Lingzhu] data URL 暂不支持，跳过`);
        } else {
          // 下载图片到本地文件
          logger.info(`[Lingzhu] 正在下载图片到本地: ${url.substring(0, 80)}...`);
          const fileUrl = await downloadImageToFile(url);
          if (fileUrl) {
            imagePaths.push(fileUrl.replace("file://", ""));
            logger.info(`[Lingzhu] 图片已保存到: ${fileUrl}`);
          } else {
            logger.warn(`[Lingzhu] 图片下载失败: ${url}`);
          }
        }
      }
    }

    // 构建最终的文本消息
    let finalContent = textParts.join("\n");

    // 如果有图片，将图片路径嵌入到消息中
    if (imagePaths.length > 0) {
      const imageRefs = imagePaths.map(p => `[图片: ${p}]`).join("\n");
      if (finalContent) {
        finalContent = `${finalContent}\n\n${imageRefs}`;
      } else {
        // 如果只有图片没有文字，添加占位文本
        finalContent = `请分析这张图片\n\n${imageRefs}`;
        logger.info("[Lingzhu] 为纯图片消息添加了占位文本");
      }
    }

    if (finalContent) {
      result.push({ role: msg.role, content: finalContent });
    }
  }

  return result;
}


/**
 * 创建 HTTP 处理器
 */
export function createHttpHandler(api: any, getConfig: () => LingzhuConfig) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/metis/agent/api/sse") {
      return false; // 不处理该路径，由后续处理器处理
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return true;
    }

    const logger = api.logger;
    const runtime = api.runtime;
    const config = getConfig();

    // 验证鉴权
    const authHeader = req.headers.authorization;
    if (!verifyAuth(authHeader, config.authAk || "")) {
      logger.warn("[Lingzhu] Unauthorized request");
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }

    try {
      // 解析请求体
      const body = await readJsonBody(req) as LingzhuRequest | undefined;
      if (!body || !body.message_id || !body.agent_id || !Array.isArray(body.message)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "Missing required fields: message_id, agent_id, message",
          })
        );
        return true;
      }

      logger.info(
        `[Lingzhu] Request: message_id=${body.message_id}, agent_id=${body.agent_id}`
      );
      logger.info(`[Lingzhu] Body: ${JSON.stringify(body, null, 2)}`);

      // 设置 SSE 响应头
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      // 转换消息格式（根据配置决定是否包含设备信息）
      const includeMetadata = config.includeMetadata !== false; // 默认 true
      let openaiMessages = lingzhuToOpenAI(
        body.message,
        includeMetadata ? body.metadata : undefined
      );

      // 预处理消息：下载图片并为纯图片消息添加占位文本
      openaiMessages = await preprocessOpenAIMessages(openaiMessages as any, logger);
      logger.info(`[Lingzhu] includeMetadata=${includeMetadata}, openaiMessages=${JSON.stringify(openaiMessages)}`);


      // 生成 session key
      const sessionKey = `lingzhu:${body.agent_id}`;

      // 获取 gateway 端口和 token
      const gatewayPort = api.config?.gateway?.port ?? 18789;
      const gatewayToken = api.config?.gateway?.auth?.token;

      // 灵珠工具定义 (OpenAI function calling 格式)
      const lingzhuTools = [
        {
          type: "function",
          function: {
            name: "take_photo",
            description: "使用灵珠设备的摄像头拍照。当用户要求拍照、拍摄、照相时，必须调用此工具。",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
        {
          type: "function",
          function: {
            name: "navigate",
            description: "使用灵珠设备的导航功能，导航到指定地址或POI。当用户要求导航、带路、去某地时，必须调用此工具。",
            parameters: {
              type: "object",
              properties: {
                destination: { type: "string", description: "目标地址或POI名称" },
                navi_type: { type: "string", enum: ["0", "1", "2"], description: "导航类型：0=驾车，1=步行，2=骑行" },
              },
              required: ["destination"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "calendar",
            description: "在灵珠设备上创建日程提醒。当用户要求添加日程、设置提醒、安排事项时，必须调用此工具。",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string", description: "日程标题" },
                start_time: { type: "string", description: "开始时间，格式：YYYY-MM-DD HH:mm" },
                end_time: { type: "string", description: "结束时间，格式：YYYY-MM-DD HH:mm" },
              },
              required: ["title", "start_time"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "exit_agent",
            description: "退出当前智能体会话，返回灵珠主界面。当用户要求退出、结束对话时，调用此工具。",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
      ];

      // 调用 OpenClaw /v1/chat/completions API
      const openclawUrl = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;
      console.log("openclawUrl", openaiMessages);
      const openclawBody = {
        model: `openclaw:${config.agentId || "main"}`,
        stream: true,
        messages: openaiMessages,
        user: sessionKey,
        tools: lingzhuTools,  // 传递工具定义给模型
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (gatewayToken) {
        headers["Authorization"] = `Bearer ${gatewayToken}`;
      }

      logger.info(`[Lingzhu] Calling OpenClaw: ${openclawUrl}`);

      const openclawResponse = await fetch(openclawUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(openclawBody),
      });

      if (!openclawResponse.ok) {
        const errorText = await openclawResponse.text();
        throw new Error(`OpenClaw API error: ${openclawResponse.status} - ${errorText}`);
      }

      // 收集完整响应用于提取 follow_up
      let fullResponse = "";

      // 工具调用累积器 - 处理流式 tool_calls 参数分片
      const toolAccumulator = new ToolCallAccumulator();

      // 流式解析 OpenAI SSE
      const reader = openclawResponse.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let streamFinished = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            streamFinished = true;
            continue;
          }

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            const finishReason = chunk.choices?.[0]?.finish_reason;

            // 调试：打印每个 SSE chunk 的关键信息
            logger.info(`[Lingzhu] SSE chunk: delta.content=${delta?.content?.substring(0, 50) || 'null'}, delta.tool_calls=${JSON.stringify(delta?.tool_calls) || 'null'}, finishReason=${finishReason || 'null'}`);

            // 累积工具调用片段（不立即发送，等完整后再发送）
            if (delta?.tool_calls) {
              logger.info(`[Lingzhu] 检测到 tool_calls 片段: ${JSON.stringify(delta.tool_calls)}`);
              toolAccumulator.accumulate(delta.tool_calls);
            }

            // 文本内容直接流式输出
            if (delta?.content) {
              fullResponse += delta.content;
              const lingzhuData = openaiChunkToLingzhu(
                chunk,
                body.message_id,
                body.agent_id
              );
              res.write(formatLingzhuSSE("message", lingzhuData));
            }

            // 当流结束且有工具调用时，发送完整的工具调用
            if (finishReason) {
              logger.info(`[Lingzhu] 流结束, finishReason=${finishReason}, hasTools=${toolAccumulator.hasTools()}`);
            }

            if (finishReason === "tool_calls" || (finishReason && toolAccumulator.hasTools())) {
              const completedTools = toolAccumulator.getCompleted();
              logger.info(`[Lingzhu] 累积的工具调用: ${JSON.stringify(completedTools)}`);

              for (const tool of completedTools) {
                const lingzhuToolCall = parseToolCallFromAccumulated(tool.name, tool.arguments);
                logger.info(`[Lingzhu] 解析工具 ${tool.name} -> ${lingzhuToolCall ? JSON.stringify(lingzhuToolCall) : 'null (未映射)'}`);

                if (lingzhuToolCall) {
                  const toolData = {
                    role: "agent" as const,
                    type: "tool_call" as const,
                    message_id: body.message_id,
                    agent_id: body.agent_id,
                    is_finish: true,
                    tool_call: lingzhuToolCall,
                  };
                  const sseOutput = formatLingzhuSSE("message", toolData);
                  logger.info(`[Lingzhu] 发送给灵珠的 SSE: ${sseOutput.replace(/\n/g, '\\n')}`);
                  res.write(sseOutput);
                }
              }
            }
          } catch {
            // 忽略解析错误
          }
        }
      }

      const hasToolCall = toolAccumulator.hasTools();

      // 如果没有工具调用，尝试从文本回复中检测意图
      if (!hasToolCall && fullResponse) {
        const detectedIntent = detectIntentFromText(fullResponse);
        if (detectedIntent) {
          logger.info(`[Lingzhu] 从文本检测到意图: ${JSON.stringify(detectedIntent)}`);
          const toolData = {
            role: "agent" as const,
            type: "tool_call" as const,
            message_id: body.message_id,
            agent_id: body.agent_id,
            is_finish: true,
            tool_call: detectedIntent,
          };
          const sseOutput = formatLingzhuSSE("message", toolData);
          logger.info(`[Lingzhu] 发送给灵珠的 SSE: ${sseOutput.replace(/\n/g, '\\n')}`);
          res.write(sseOutput);
        } else {
          // 没有检测到意图，尝试提取 follow_up 建议
          const suggestions = extractFollowUpFromText(fullResponse);
          if (suggestions && suggestions.length > 0) {
            const followUpData = createFollowUpResponse(
              suggestions,
              body.message_id,
              body.agent_id
            );
            res.write(formatLingzhuSSE("message", followUpData));
          }
        }
      }

      // 发送结束事件
      res.write(formatLingzhuSSE("done", "[DONE]"));
      res.end();

      logger.info(`[Lingzhu] Completed: message_id=${body.message_id}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[Lingzhu] Error: ${errorMsg}`);

      // 发送错误响应
      const errorData = {
        role: "agent" as const,
        type: "answer" as const,
        answer_stream: `[错误] ${errorMsg}`,
        message_id: (req as any).body?.message_id || "unknown", // Fallback if body parsing failed
        agent_id: (req as any).body?.agent_id || "unknown",
        is_finish: true,
      };
      res.write(formatLingzhuSSE("message", errorData));
      res.write(formatLingzhuSSE("done", "[DONE]"));
      res.end();
    }

    return true;
  };
}
