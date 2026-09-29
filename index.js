import express from "express";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

// ===== 配置 =====
const VERSION = "1.3.0";
const PORT = process.env.PORT || 3000;
const STICKER_REPO = "izumi05012-cmyk/rp-stickers";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const LIST_TTL_MS = 10 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const IMAGE_CACHE_MAX = 40;

const stickerCdn = (file) =>
  `https://cdn.jsdelivr.net/gh/${STICKER_REPO}@main/${encodeURI(file)}`;

const KNOWN_BIRD = [
  "big_teary_crying.png", "bless.png", "cheeky_side_glance.png", "coquettish_big_eyes.png",
  "hand_chin_skeptical.png", "hand_reach_give.png", "hand_reject_no.png", "head_down_dejected.png",
  "head_on_fire.png", "heart_cheering.png", "lightbulb_idea.png", "sly_squint_eyes.png",
  "sparkling_eyes.png", "surprised.png", "sweating_shocked.png", "tilted_head_confused.png",
  "twirl_sparkle.png", "wide_eyed_watching.png", "woken_up_annoyed.png",
];
const KNOWN_FOX = [
  "fox/angry.gif", "fox/apple.gif", "fox/drink.gif", "fox/eat.gif", "fox/emperor.png",
  "fox/flower.gif", "fox/friend.gif", "fox/gift.png", "fox/glasses.gif", "fox/goodnight.gif",
  "fox/hug.gif", "fox/hug_me.png", "fox/hug_open.png", "fox/jealous.png", "fox/kiss_phone.png",
  "fox/laugh_phone.png", "fox/leaf.gif", "fox/love_heart.png", "fox/ok.gif", "fox/peek.png",
  "fox/pet.gif", "fox/pillow.gif", "fox/quiet.gif", "fox/relax.gif", "fox/rose.png",
  "fox/sit.gif", "fox/sit2.gif", "fox/sleep.gif", "fox/sleep_drool.png", "fox/stare.gif",
  "fox/stare_long.png", "fox/teary.png", "fox/together.gif",
];
const KNOWN = [...KNOWN_BIRD, ...KNOWN_FOX];

class NoRetry extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (content) => ({ content });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });

async function withRetry(fn, retries) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (e instanceof NoRetry) break;
      if (i < retries) await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || a >= 224);
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("::ffff:")) {
      const rest = v.slice(7);
      return net.isIPv4(rest) ? isPrivateIp(rest) : true;
    }
    return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") ||
      v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
  }
  return true;
}

async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new NoRetry("图片链接格式不正确"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new NoRetry("只支持 http/https 链接");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true }).catch(() => { throw new Error(`域名解析失败: ${host}`); });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new NoRetry("不允许访问内网地址");
}

async function fetchImageOnce(url, checkHost) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (checkHost) await assertPublicUrl(current);
    const resp = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": `mcp-image-render/${VERSION}` },
    });
    const loc = resp.headers.get("location");
    if (resp.status >= 300 && resp.status < 400 && loc) {
      current = new URL(loc, current).href;
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const mimeType = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!mimeType.startsWith("image/")) throw new NoRetry(`链接返回的不是图片 (${mimeType || "未知类型"})`);
    const declared = Number(resp.headers.get("content-length"));
    if (declared > MAX_IMAGE_BYTES) throw new NoRetry("图片太大（上限 5MB）");
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new NoRetry("图片太大（上限 5MB）");
    return { data: buf.toString("base64"), mimeType };
  }
  throw new NoRetry("重定向次数过多");
}

const fetchImage = (url, { checkHost = true, retries = 1 } = {}) =>
  withRetry(() => fetchImageOnce(url, checkHost), retries);

let stickerCache = { at: 0, ttl: 0, files: KNOWN };
let listing = null;

function listStickers() {
  if (Date.now() - stickerCache.at < stickerCache.ttl) return Promise.resolve(stickerCache.files);
  listing ??= (async () => {
    try {
      const resp = await fetch(
        `https://data.jsdelivr.com/v1/packages/gh/${STICKER_REPO}@main?structure=flat`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const imgs = (data.files || [])
        .map((f) => f.name.replace(/^\//, ""))
        .filter((n) => /\.(png|jpe?g|gif|webp)$/i.test(n));
      stickerCache = { at: Date.now(), ttl: LIST_TTL_MS, files: [...new Set([...imgs, ...KNOWN])] };
    } catch (e) {
      console.warn("列表接口失败，使用内置清单:", e.message);
      stickerCache = { at: Date.now(), ttl: 60_000, files: KNOWN };
    }
    return stickerCache.files;
  })().finally(() => { listing = null; });
  return listing;
}

const imageCache = new Map();
async function getStickerImage(file) {
  const key = stickerCdn(file);
  if (imageCache.has(key)) {
    const hit = imageCache.get(key);
    imageCache.delete(key);
    imageCache.set(key, hit);
    return hit;
  }
  const img = await fetchImage(key, { checkHost: false, retries: 2 });
  imageCache.set(key, img);
  if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  return img;
}

const baseName = (f) => f.split("/").pop().replace(/\.[^.]+$/, "");
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickCandidates(pack, name, pool) {
  if (!name) return shuffle(pool).slice(0, 3);
  const clean = String(name).trim().replace(/^fox\//, "");
  if (!/^[\w.\- ]{1,80}$/.test(clean)) throw new NoRetry("贴纸名称不合法");
  const withDir = pack === "fox" ? `fox/${clean}` : clean;
  if (/\.(png|jpe?g|gif|webp)$/i.test(clean)) return [withDir];
  const matched = pool.filter((f) => baseName(f).toLowerCase() === clean.toLowerCase());
  if (matched.length) return matched;
  throw new NoRetry(`分类 ${pack} 里找不到「${clean}」`);
}

function createServer() {
  const server = new Server(
    { name: "image-render", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "render_image",
        description: "加载网络图片链接并在对话中显示（仅支持公网 http/https 图片，≤5MB）",
        inputSchema: {
          type: "object",
          properties: { imageUrl: { type: "string", description: "图片直链" } },
          required: ["imageUrl"],
        },
      },
      {
        name: "send_sticker",
        description:
          "从用户的 rp-stickers 仓库发一张贴纸表情包。两个分类：bird=小鸟贴纸（仓库根目录），fox=小狐狸贴纸（fox/ 文件夹）。根据聊天语境自己挑合适的分类；不指定 name 就在该分类里随机挑一张；指定 name 则发那张（可带或不带扩展名，例如 sleep、hug.gif、surprised）。",
        inputSchema: {
          type: "object",
          properties: {
            pack: { type: "string", enum: ["bird", "fox"], description: "贴纸分类：bird=小鸟，fox=小狐狸。默认 bird。" },
            name: { type: "string", description: "贴纸名，例如 sleep 或 sleep.gif（fox）、surprised（bird）。不填则随机。" },
          },
          required: [],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: tool } = request.params;
    const args = request.params.arguments ?? {};

    if (tool === "render_image") {
      if (typeof args.imageUrl !== "string" || !args.imageUrl) return fail("缺少 imageUrl 参数");
      try {
        const img = await fetchImage(args.imageUrl);
        return ok([{ type: "image", ...img }]);
      } catch (e) { return fail(`图片加载失败: ${e.message}`); }
    }

    if (tool === "send_sticker") {
      const pack = args.pack === "fox" ? "fox" : "bird";
      try {
        const all = await listStickers();
        const pool = all.filter((f) => (pack === "fox" ? f.startsWith("fox/") : !f.includes("/")));
        if (!pool.length && !args.name) throw new Error(`分类 ${pack} 里还没有贴纸`);
        let lastErr;
        for (const file of pickCandidates(pack, args.name, pool)) {
          try {
            const img = await getStickerImage(file);
            return ok([{ type: "image", ...img }, { type: "text", text: file }]);
          } catch (e) { lastErr = e; }
        }
        throw lastErr ?? new Error("没有可用的贴纸");
      } catch (e) { return fail(`贴纸发送失败: ${e.message}`); }
    }

    return fail(`未知工具: ${tool}`);
  });

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
const sessions = new Map();

async function handleNewConnection(req, res) {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport, server, lastSeen: Date.now() });
      console.log("new session:", sid, "| total:", sessions.size);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId && sessions.delete(transport.sessionId)) {
      console.log("session closed:", transport.sessionId, "| total:", sessions.size);
    }
  };
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

const rpcError = (res, status, message, code = -32000) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

function getSession(req) {
  const sid = req.headers["mcp-session-id"];
  const s = sid ? sessions.get(sid) : undefined;
  if (s) s.lastSeen = Date.now();
  return { sid, session: s };
}

app.post("/", async (req, res) => {
  try {
    const { sid, session } = getSession(req);
    if (session) return await session.transport.handleRequest(req, res, req.body);
    if (sid) return rpcError(res, 404, "Session not found, please re-initialize");
    if (!isInitializeRequest(req.body)) return rpcError(res, 400, "Missing session id");
    await handleNewConnection(req, res);
  } catch (e) {
    console.error("❌ POST错误:", e);
    if (!res.headersSent) rpcError(res, 500, e.message, -32603);
  }
});

app.get("/", async (req, res) => {
  const { sid, session } = getSession(req);
  if (session) {
    try { return await session.transport.handleRequest(req, res); }
    catch (e) {
      console.error("❌ GET错误:", e);
      if (!res.headersSent) res.status(500).end();
      return;
    }
  }
  if (sid) return rpcError(res, 404, "Session not found, please re-initialize");
  res.send(`MCP image server is running v${VERSION}`);
});

app.delete("/", async (req, res) => {
  const { session } = getSession(req);
  if (!session) return rpcError(res, 404, "Session not found");
  try { await session.transport.handleRequest(req, res); }
  catch (e) {
    console.error("❌ DELETE错误:", e);
    if (!res.headersSent) res.status(500).end();
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, version: VERSION, sessions: sessions.size }));

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > SESSION_IDLE_MS) {
      console.log("session idle timeout:", sid);
      sessions.delete(sid);
      s.transport.close().catch(() => {});
    }
  }
}, 60_000).unref();

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ MCP image server running v${VERSION} on :${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM, shutting down...");
  for (const s of sessions.values()) s.transport.close().catch(() => {});
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
