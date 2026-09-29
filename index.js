import express from "express";

import { randomUUID } from "crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ===== 贴纸仓库配置 =====

const STICKER_REPO = "izumi05012-cmyk/rp-stickers";

const stickerCdn = (file) =>

`https://cdn.jsdelivr.net/gh/${STICKER_REPO}@main/${encodeURI(file)}`;

// 文件列表缓存 10 分钟，避免每次都打 API

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

// 拉图片，遇到 404/网络错误自动重试 2 次（jsDelivr 边缘节点偶尔抽风）

async function fetchImageAsBase64(url, retries = 2) {

let lastErr;

for (let i = 0; i <= retries; i++) {

try {

const resp = await fetch(url);

if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

const buf = Buffer.from(await resp.arrayBuffer());

const mimeType = resp.headers.get("content-type") || "image/png";

return { data: buf.toString("base64"), mimeType };

} catch (e) {

lastErr = e;

if (i < retries) await new Promise((r) => setTimeout(r, 800 * (i + 1)));

}

}

throw lastErr;

}

function createServer() {

const server = new Server(

{ name: "image-render", version: "1.2.0" },

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

description:

"从用户的 rp-stickers 仓库发一张贴纸表情包。两个分类：bird=小鸟贴纸（仓库根目录），fox=小狐狸贴纸（fox/ 文件夹）。根据聊天语境自己挑合适的分类；不指定 name 就在该分类里随机挑一张；指定 name 则发那张（例如 fox、sleep、hug 等）。",

inputSchema: {

type: "object",

properties: {

pack: {

type: "string",

enum: ["bird", "fox"],

description: "贴纸分类：bird=小鸟，fox=小狐狸。默认 bird。"

},

name: {

type: "string",

description: "贴纸文件名，例如 sticker2.png（bird）或 sleep.gif（fox）。不填则随机。"

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

const { pack = "bird", name } = request.params.arguments || {};

try {

const all = await listStickers();

// bird = 根目录下的图（不带文件夹）；fox = fox/ 开头

const pool = all.filter((f) =>

pack === "fox" ? f.startsWith("fox/") : !f.includes("/")

);

if (!pool.length) throw new Error(`分类 ${pack} 里还没有贴纸`);

let file;

if (name) {

// 允许只写文件名，自动补上 fox/ 前缀

const candidate =

pack === "fox" && !name.startsWith("fox/") ? `fox/${name}` : name;

if (!pool.includes(candidate)) {

throw new Error(`${pack} 里没有 ${name}，现有: ${pool.join(", ")}`);

}

file = candidate;

} else {

// 随机挑；如果挑到的图拉取失败，换一张再试

const tried = new Set();

let lastErr;

for (let i = 0; i < Math.min(3, pool.length); i++) {

file = pool[Math.floor(Math.random() * pool.length)];

if (tried.has(file) && tried.size < pool.length) continue;

tried.add(file);

try {

const img = await fetchImageAsBase64(stickerCdn(file));

return {

content: [

{ type: "image", ...img },

{ type: "text", text: file }

]

};

} catch (e) {

lastErr = e;

}

}

throw lastErr;

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

console.log("✅ MCP image server running v1.2.0");

});
