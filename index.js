import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const server = new Server(
  { name: "image-render", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// 工具列表
server.setRequestHandler("tools/list", async () => {
  return {
    tools: [
      {
        name: "render_image",
        description: "渲染网络图片，用于RP剧情对话",
        inputSchema: {
          "type": "object",
          "properties": {
            "imageUrl": {
              "type": "string",
              "description": "jsdelivr图片CDN链接"
            },
            "width": {
              "type": "number",
              "description": "图片展示宽度"
            },
            "borderRadius": {
              "type": "number",
              "description": "图片圆角大小"
            }
          },
          "required": ["imageUrl"]
        }
      }
    ]
  };
});

// 调用工具
server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "render_image") {
    const { imageUrl, width = 160, borderRadius = 12 } = request.params.arguments;
    return {
      content: [
        {
          type: "image",
          image_url: { url: imageUrl }
        }
      ]
    };
  }
  throw new Error("unknown tool");
});

const transport = new StreamableHTTPServerTransport({
  port: process.env.PORT || 3000
});

await server.connect(transport);
console.log(`✅ MCP image server running`);
