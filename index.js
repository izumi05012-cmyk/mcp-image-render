import express from "express";
import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function createServer() {
  const server = new Server(
    { name: "image-render", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "render_image",
        description: "加载网络表情包图片并在对话中显示",
        inputSchema: {
          type: "object",
          properties: {
            imageUrl: { type: "string", description: "表情包图片CDN链接" },
            width: { type: "number", description: "图片展示宽度" },
            borderRadius: { type: "number", description: "图片圆角大小" }
          },
          required: ["imageUrl"]
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "render_image") {
      const { imageUrl, width = 160, borderRadius = 12 } = request.params.arguments;
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
    throw new Error("unknown tool");
  });

  return server;
}

const app = express();
app.use(express.json());

// 每个客户端一个独立会话：支持两个号同时连、断线重连不再 400
const sessions = new Map();

async function handleNewConnection(req, res) {
  const server = createServer();

  // sessionId 要等 initialize 完成后才生成，用构造回调把会话存进 sessions
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport, server });
      console.log("new session:", sid, "| total:", sessions.size);
    },
  });
  await server.connect(transport);

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
      console.log("session closed:", transport.sessionId);
    }
  };

  await transport.handleRequest(req, res, req.body);
}

app.post("/", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) {
      await session.transport.handleRequest(req, res, req.body);
    } else {
      await handleNewConnection(req, res);
    }
  } catch (e) {
    console.error("❌ POST错误:", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { message: e.message } });
    }
  }
});

app.get("/", (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    sessions.get(sessionId).transport.handleRequest(req, res).catch((e) =>
      console.error("❌ GET错误:", e)
    );
    return;
  }
  res.send("MCP image server is running");
});

app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("✅ MCP image server running");
});
