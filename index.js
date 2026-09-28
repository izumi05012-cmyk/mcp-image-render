import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { createServer } from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();
const httpServer = createServer(app);

// MCP Server
const mcpServer = new McpServer({
  name: "image-render",
  version: "1.0.0"
});

// 注册表情包工具
mcpServer.tool("show_sticker",
  "展示rp表情包，输入图片cdn链接即可渲染图片",
  {
    url: z.string().describe("表情包CDN地址")
  },
  async ({ url }) => {
    return {
      content: [{
        type: "image",
        data: url,
        mimeType: "image/png"
      }]
    }
  }
);

// SSE会话管理
let transport;
app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/message", res);
  await mcpServer.connect(transport);
});
app.post("/message", express.raw({type:"*/*"}), async (req, res) => {
  if (!transport) return res.status(400).end();
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`MCP server running on port ${PORT}`);
});
