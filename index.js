import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const server = new McpServer({
  name: "image-render",
  version: "1.0.0"
});

server.registerTool(
  "render_image",
  "渲染网络图片，用于RP剧情对话",
  {
    imageUrl: { type: "string", description: "jsdelivr图片CDN链接" },
    width: { type: "number", description: "图片展示宽度" },
    borderRadius: { type: "number", description: "图片圆角大小" }
  },
  async ({ imageUrl, width = 160, borderRadius = 12 }) => {
    return {
      content: [{ type: "image", image_url: { url: imageUrl } }]
    };
  }
);

const app = express();
app.use(express.json());

const transport = new StreamableHTTPServerTransport({});

// MCP请求入口：根路径 /
app.post("/", async (req, res) => {
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

// 健康检查：浏览器直接访问能看到提示
app.get("/", (req, res) => {
  res.send("MCP image server is running");
});

app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("✅ MCP image server running");
});
