import express from "express";
import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const STICKER_REPO = "izumi05012-cmyk/rp-stickers";
const stickerCdn = (file) => `https://cdn.jsdelivr.net/gh/${STICKER_REPO}@main/${file}`;

let stickerCache = { at: 0, files: [] };
async function listStickers() {
  if (Date.now() - stickerCache.at < 10 * 60 * 1000 && stickerCache.files.length) {
    return stickerCache.files;
  }
  const resp = await fetch(
    `https://data.jsdelivr.com/v1/packages/gh/${STICKER_REPO}@main?structure=flat`
  );
  if (!resp.ok) throw new Error(`jsDelivr API ${resp.status}`);
  const data = await resp.json();
  const imgs = (data.files || [])
    .map((f) => f.name.replace(/^\//, ""))
    .filter((n) => /\.(png|jpe?g|gif|webp)$/i.test(n));
  stickerCache = { at: Date.now(), files: imgs };
  return imgs;
}

async function fetchImageAsBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const mimeType = resp.headers.get("content-type") || "image/png";
  return { data: buf.toString("base64"), mimeType };
}

function createServer() {
  const server = new Server(
    { name: "image-render", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "render_image",
        description: "加载网络图片链接并在对话中显示",
        inputSchema: {
          type: "object",
          properties: {
            imageUrl: { type: "string", description: "图片直链" },
            width: { type: "number", description: "图片展示宽度" },
            borderRadius: { type: "number", description: "图片圆角大小" }
          },
          required: ["imageUrl"]
        }
      },
      {
        name: "send_sticker",
        description: "从用户的 rp-stickers 仓库发一张贴纸表情包。可以自己挑合适的一张，也可以随机发；指定名字则发那张。",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "贴纸文件名，例如 sticker2.png。不填则随机挑一张。"
            }
          },
          required: []
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "render_image") {
      const { imageUrl } = request.params.arguments;
      try {
        const img = await fetchImageAsBase64(imageUrl);
        return { content: [{ type: "image", ...img }] };
      } catch (e) {
        return { content: [{ type: "text", text: `图片加载失败: ${e.message}` }] };
      }
    }

    if (request.params.name === "send_sticker") {
      const { name } = request.params.arguments || {};
      try {
        const files = await listStickers();
        let file = name;
        if (!file) {
          file = files[Math.floor(Math.random() * files.length)];
        } else if (!files.includes(file)) {
          throw new Error(`仓库里没有 ${name}，现有贴纸: ${files.slice(0, 20).join(", ")}${files.length > 20 ? " ..." : ""}`);
        }
        const img = await fetchImageAsBase64(stickerCdn(file));
        return {
          content: [
            { type: "image", ...img },
            { type: "text", text: file }
          ]
        };
      } catch (e) {
        return { content: [{ type: "text", text: `贴纸发送失败: ${e.message}` }] };
      }
    }

    throw new Error("unknown tool");
  });

  return server;
}

const app = express();
app.use(express.json());

const sessions = new Map();

async function handleNewConnection(req, res) {
  const server = createServer();
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
