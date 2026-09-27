"""Loaded in a separate hidden GUI Blender; never changes user preferences."""
import importlib.util
import json
import os
import sys
from pathlib import Path
import bpy

config = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text(encoding="utf-8-sig"))
bpy.context.preferences.use_preferences_save = False
os.environ["BLENDER_MCP_DISABLE_TELEMETRY"] = "1"
spec = importlib.util.spec_from_file_location("blendermcp", config["addon"])
addon = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = addon
spec.loader.exec_module(addon)
addon.register()
server = addon.BlenderMCPServer(host="127.0.0.1", port=config["port"])
server.start()
if not server.running:
    raise RuntimeError("MCP addon did not start")
Path(config["ready"]).write_text(json.dumps({"pid": os.getpid(), "port": config["port"]}), encoding="utf-8")
