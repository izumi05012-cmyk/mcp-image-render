import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const server = new Server(
  { name: "image-render", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.tool(
  "render_image",
  "渲染网络图片，用于RP剧情对话",
  {
    imageUrl: {type:"string",description:"jsdelivr图片CDN链接"},
    width: {type:"number",description:"图片展示宽度"},
    borderRadius: {type:"number",description:"图片圆角大小"}
  },
  async ({imageUrl,width=160,borderRadius=12})=>{
    return {
      content: [
        {type:"image",image_url:{url:imageUrl}},
        {type:"text",text:`图片渲染完成，宽${width}px，圆角${borderRadius}px`}
      ]
    }
  }
);

const transport = new StreamableHTTPServerTransport({port:3000});
await server.connect(transport);
console.log("MCP Streamable HTTP server running");
