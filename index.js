import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const server = new McpServer({
  name: "image-render",
  version: "1.0.0"
});

server.registerTool(
  "render_image",
  "加载网络表情包图片并在对话中显示",
  {
    imageUrl: { type: "string", description: "表情包图片CDN链接" },
    width: { type: "number", description: "图片展示宽度" },
    borderRadius: { type: "number", description: "图片圆角大小" }
  },
  async ({ imageUrl, width = 160, borderRadius = 12 }) => {
    try {
      const resp = await fetch(imageUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const mimeType = resp.headers.get("content-type") || "image/png";
      return {
        content: [{ type: "image", data: buf.toString("base64"), mimeType }]
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `图片加载失败: ${e.message}` }]
      };
    }
  }
);

const app = express();
app.use(express.json());

// 有状态模式：transport可跨请求复用，每个客户端分配session
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID()
});
await server.connect(transport);

app.post("/", async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

app.get("/", (req, res) => {
  res.send("MCP image server is running");
});

app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("✅ MCP image server running");
});
