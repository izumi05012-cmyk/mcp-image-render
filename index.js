import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// 高层McpServer，1.0.0推荐，直接.registerTool
const server = new McpServer({
  name: "image-render",
  version: "1.0.0"
});

// 注册图片渲染工具，新版直接用registerTool
server.registerTool(
  "render_image",
  "渲染网络图片，用于RP剧情对话",
  {
    imageUrl: {
      type: "string",
      description: "jsdelivr图片CDN链接"
    },
    width: {
      type: "number",
      description: "图片展示宽度"
    },
    borderRadius: {
      type: "number",
      description: "图片圆角大小"
    }
  },
  async ({ imageUrl, width = 160, borderRadius = 12 }) => {
    return {
      content: [
        {
          type: "image",
          image_url: { url: imageUrl }
        }
      ]
    };
  }
);

const transport = new StreamableHTTPServerTransport({
  port: process.env.PORT || 3000
});

await server.connect(transport);
console.log(`✅ MCP image server running`);
