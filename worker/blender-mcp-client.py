"""Local CLI client for the pinned upstream MCP server; no model/API key needed."""
import asyncio
import json
import os
import sys
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    env = dict(os.environ, BLENDER_HOST="127.0.0.1",
               BLENDER_PORT=str(request["port"]), BLENDER_MCP_DISABLE_TELEMETRY="1")
    server = StdioServerParameters(command=sys.executable,
                                  args=["-m", "blender_mcp.server"], env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(request["tool"], request.get("arguments", {}))
            payload = result.model_dump(mode="json")
            Path(request["result"]).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            messages = [c.text for c in result.content if c.type == "text"]
            if result.isError or any(t.startswith(("Error", "Rejected")) for t in messages):
                raise RuntimeError("\n".join(messages))
            print("\n".join(messages))


if __name__ == "__main__":
    asyncio.run(main())
