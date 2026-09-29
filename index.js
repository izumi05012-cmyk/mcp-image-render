import express from "express";
import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const MUSIC_BASE = process.env.MUSIC_BASE || "https://one-earbud.onrender.com/api/music";
const MUSIC_TOKEN = process.env.MUSIC_TOKEN || "myearbud123";
const FETCH_TIMEOUT_MS = 15000;

// ---- 贴纸仓库配置 ----
const STICKER_REPO = process.env.STICKER_REPO || "izumi05012-cmyk/rp-stickers";
const STICKER_BRANCH = process.env.STICKER_BRANCH || "main";
const STICKER_CDN = `https://cdn.jsdelivr.net/gh/${STICKER_REPO}@${STICKER_BRANCH}`;
const STICKER_LIST_API = `https://data.jsdelivr.com/v1/packages/gh/${STICKER_REPO}@${STICKER_BRANCH}?structure=flat`;
const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;

// 贴纸文件名缓存,避免每次都请求 jsDelivr 的目录接口
let stickerCache = { at: 0, bird: [], fox: [] };
const STICKER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟

async function loadStickerList() {
  if (Date.now() - stickerCache.at < STICKER_CACHE_TTL_MS && (stickerCache.bird.length || stickerCache.fox.length)) {
    return stickerCache;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(STICKER_LIST_API, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const files = (data.files || []).map(f => f.name.replace(/^\//, ""));
    const bird = files.filter(f => IMG_EXT.test(f) && !f.startsWith("fox/"));
    const fox = files.filter(f => IMG_EXT.test(f) && f.startsWith("fox/")).map(f => f.replace(/^fox\//, ""));
    stickerCache = { at: Date.now(), bird, fox };
    return stickerCache;
  } finally {
    clearTimeout(timer);
  }
}

function pickSticker(list, name) {
  if (!list.length) return null;
  if (!name) return list[Math.floor(Math.random() * list.length)];
  const exact = list.find(f => f === name);
  if (exact) return exact;
  const byStem = list.find(f => f.replace(IMG_EXT, "") === name.replace(IMG_EXT, ""));
  return byStem || null;
}

// ---- 图片加载的域名白名单,避免被当作任意网址的探测工具(SSRF)使用 ----
const ALLOWED_IMAGE_HOSTS = [
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
  "cdn.claudeimagine.com",
];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB

function isAllowedImageUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return false;
    return ALLOWED_IMAGE_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

async function fetchImageAsBase64(imageUrl) {
  if (!isAllowedImageUrl(imageUrl)) {
    throw new Error(`图片域名不在白名单内: ${(() => { try { return new URL(imageUrl).hostname; } catch { return imageUrl; } })()}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(imageUrl, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const len = Number(resp.headers.get("content-length") || 0);
    if (len && len > MAX_IMAGE_BYTES) throw new Error(`图片太大(${(len / 1024 / 1024).toFixed(1)}MB),超过限制`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error("图片太大,超过限制");
    const mimeType = resp.headers.get("content-type") || "image/png";
    return { data: buf.toString("base64"), mimeType };
  } finally {
    clearTimeout(timer);
  }
}

async function musicFetch(path, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${MUSIC_BASE}${path}`, {
      ...options,
      headers: {
        "Authorization": MUSIC_TOKEN,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      signal: ctrl.signal,
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

function requireFields(args, fields) {
  const missing = fields.filter(f => args[f] === undefined || args[f] === null || args[f] === "");
  return missing;
}

function createServer() {
  const server = new Server(
    { name: "image-render", version: "1.7.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "render_image",
        description: "加载网络表情包图片并在对话中显示(仅支持白名单图床域名)",
        inputSchema: {
          type: "object",
          properties: {
            imageUrl: { type: "string" },
            width: { type: "number" },
            borderRadius: { type: "number" }
          },
          required: ["imageUrl"]
        }
      },
      {
        name: "send_sticker",
        description: "从用户的 rp-stickers 仓库发一张贴纸表情包。两个分类:bird=小鸟贴纸(仓库根目录),fox=小狐狸贴纸(fox/ 文件夹)。不指定 name 就在该分类里随机挑一张。",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "贴纸名,例如 sleep 或 sleep.gif(fox)、surprised(bird)。不填则随机。" },
            pack: { type: "string", enum: ["bird", "fox"], description: "贴纸分类:bird=小鸟,fox=小狐狸。默认 bird。" }
          }
        }
      },
      {
        name: "music_tool",
        description: "和用户一起听网易云。actions: now_playing(看用户在听啥,无参数)、search(搜歌,需 query)、lyrics(读歌词,需 songId)、queue(看列表)、play_next(把歌排到当前这首后面,需 songId 或 name+artist)、play_now(直接给用户放,需 songId 或 name+artist)、queue_add(加到列表最后,需 songId 或 name+artist)。可选 note 是给用户的一句话≤300字。",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["now_playing", "search", "lyrics", "queue", "play_next", "play_now", "queue_add"]
            },
            songId: { type: "number" },
            query: { type: "string" },
            name: { type: "string", description: "歌曲名（排歌时用,可替代 songId）" },
            artist: { type: "string", description: "歌手名（排歌时用）" },
            note: { type: "string" }
          },
          required: ["action"]
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};

    if (name === "render_image") {
      const { imageUrl, width = 160, borderRadius = 12 } = args;
      try {
        const { data, mimeType } = await fetchImageAsBase64(imageUrl);
        return { content: [{ type: "image", data, mimeType }], _meta: { width, borderRadius } };
      } catch (e) {
        return { content: [{ type: "text", text: `图片加载失败: ${e.message}` }], isError: true };
      }
    }

    if (name === "send_sticker") {
      try {
        const pack = args.pack === "fox" ? "fox" : "bird";
        const list = await loadStickerList();
        const pool = pack === "fox" ? list.fox : list.bird;
        if (!pool.length) {
          return { content: [{ type: "text", text: `贴纸库里 ${pack} 分类暂时是空的,可能还没同步或名字对不上。` }], isError: true };
        }
        const picked = pickSticker(pool, args.name);
        if (!picked) {
          return { content: [{ type: "text", text: `没找到叫 "${args.name}" 的 ${pack} 贴纸。现有: ${pool.slice(0, 20).join(", ")}${pool.length > 20 ? " ..." : ""}` }], isError: true };
        }
        const fullPath = pack === "fox" ? `fox/${picked}` : picked;
        const url = `${STICKER_CDN}/${fullPath}`;
        const { data, mimeType } = await fetchImageAsBase64(url);
        return { content: [{ type: "image", data, mimeType }, { type: "text", text: fullPath }] };
      } catch (e) {
        return { content: [{ type: "text", text: `贴纸加载失败: ${e.message}` }], isError: true };
      }
    }

    if (name === "music_tool") {
      try {
        const { action } = args;
        let result;
        if (action === "now_playing") {
          result = await musicFetch("/now-playing");
        } else if (action === "search") {
          const missing = requireFields(args, ["query"]);
          if (missing.length) return { content: [{ type: "text", text: `缺少参数: ${missing.join(", ")}` }], isError: true };
          result = await musicFetch(`/search?q=${encodeURIComponent(args.query)}&limit=10`);
        } else if (action === "lyrics") {
          const missing = requireFields(args, ["songId"]);
          if (missing.length) return { content: [{ type: "text", text: `缺少参数: ${missing.join(", ")}` }], isError: true };
          result = await musicFetch(`/song/${args.songId}`);
        } else if (action === "queue") {
          result = await musicFetch("/queue");
        } else if (["play_next", "play_now", "queue_add"].includes(action)) {
          const hasId = args.songId !== undefined && args.songId !== null;
          const hasNameArtist = !!args.name;
          if (!hasId && !hasNameArtist) {
            return { content: [{ type: "text", text: "需要提供 songId,或者至少提供 name(歌名)" }], isError: true };
          }
          const song = { songId: hasId ? String(args.songId) : "", title: args.name || "", artist: args.artist || "" };
          const endpoint = action === "play_next" ? "/queue/next" : action === "play_now" ? "/queue/now" : "/queue/append";
          const body = action === "queue_add" ? { songs: [song] } : { song };
          result = await musicFetch(endpoint, { method: "POST", body: JSON.stringify(body) });
        } else {
          return { content: [{ type: "text", text: "unknown action: " + action }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `音乐接口错误: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: "text", text: "unknown tool: " + name }], isError: true };
  });

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// 简单 CORS,方便本地/浏览器端客户端联调
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const sessions = new Map();
const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 分钟没用就清理

async function handleNewConnection(req, res) {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport, server, lastUsed: Date.now() });
      console.log("new session:", sid, "| total:", sessions.size);
    },
  });
  await server.connect(transport);
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await transport.handleRequest(req, res, req.body);
}

function touchSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.lastUsed = Date.now();
  return s;
}

app.post("/", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    const session = sessionId ? touchSession(sessionId) : undefined;
    if (session) await session.transport.handleRequest(req, res, req.body);
    else await handleNewConnection(req, res);
  } catch (e) {
    console.error("POST error:", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { message: e.message } });
  }
});

// Streamable HTTP 需要 GET 来做服务端到客户端的流式推送
app.get("/", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const session = sessionId ? touchSession(sessionId) : undefined;
  if (!session) return res.status(400).json({ error: "invalid or missing session" });
  try {
    await session.transport.handleRequest(req, res);
  } catch (e) {
    console.error("GET error:", e);
    if (!res.headersSent) res.status(500).end();
  }
});

// DELETE 用于客户端主动结束会话
app.delete("/", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) return res.status(400).json({ error: "invalid or missing session" });
  try {
    await session.transport.handleRequest(req, res);
  } finally {
    sessions.delete(sessionId);
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, version: "1.7.0", sessions: sessions.size }));

// 定期清理长时间没用的空闲会话,避免内存慢慢涨上去
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (now - s.lastUsed > SESSION_IDLE_MS) {
      try { s.transport.close?.(); } catch {}
      sessions.delete(sid);
      console.log("cleaned idle session:", sid);
    }
  }
}, 5 * 60 * 1000);

app.listen(process.env.PORT || 3000, "0.0.0.0", () => console.log("✅ MCP v1.7 (with stickers + music + safety)"));
