"""AutomationBench tasks as a stdio MCP server for headless DSH.

Run inside the AutomationBench checkout's environment:

    uv run --project <AB_REPO> python ab_bench.py prepare <names.json> <out_dir>
    uv run --project <AB_REPO> python ab_bench.py serve <task.json> <world.json>
    uv run --project <AB_REPO> python ab_bench.py grade <task.json> <world.json>

`serve` builds the task's world exactly as AutomationBenchEnv.setup_state does
and exposes the benchmark's own `api` toolset (api_search, api_fetch,
base64_encode). After every api_fetch it writes the world to <world.json>, so
grading reads the state the agent left behind. `grade` runs the benchmark's
own rubric (partial_credit, task_completed_correctly).
"""

from __future__ import annotations

import copy
import json
import os
import sys
from pathlib import Path


def load_task(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def initial_world(task: dict):
    from automationbench.runner import compute_allowed_services, strip_none_values
    from automationbench.schema.world import WorldState

    info = task["info"]
    initial = strip_none_values(info.get("initial_state", {}))
    world = WorldState(**initial)
    world.meta.allowed_services = compute_allowed_services(
        initial, info.get("assertions", []), info.get("zapier_tools", [])
    )
    return world, initial


def prepare(names_path: str, out_dir: str) -> None:
    from automationbench.domains import DEFAULT_DOMAINS, get_combined_dataset

    names = json.loads(Path(names_path).read_text(encoding="utf-8"))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    found = {}
    for row in get_combined_dataset(DEFAULT_DOMAINS):
        info = row["info"]
        info = json.loads(info) if isinstance(info, str) else info
        name = info.get("task_name")
        if name in names:
            found[name] = {"name": name, "prompt": row["prompt"], "info": info}
    missing = [n for n in names if n not in found]
    if missing:
        raise SystemExit(f"tasks not found: {missing}")
    for name in names:
        (out / f"{name}.json").write_text(json.dumps(found[name], ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"prepared": len(names)}))


def serve(task_path: str, world_path: str) -> None:
    from mcp.server.fastmcp import FastMCP

    from automationbench.tools.api import api_fetch, api_search, base64_encode

    task = load_task(task_path)
    world, _ = initial_world(task)
    out = Path(world_path)

    def save() -> None:
        tmp = out.with_suffix(".tmp")
        tmp.write_text(world.model_dump_json(), encoding="utf-8")
        os.replace(tmp, out)

    mcp = FastMCP("automationbench", log_level="WARNING")

    @mcp.tool(name="api_search", description=api_search.__doc__)
    def search(query: str, top_k: int = 5) -> str:
        return api_search(query, top_k)

    @mcp.tool(name="api_fetch", description=api_fetch.__doc__)
    def fetch(method: str, url: str, params: str | None = None, body: str | None = None) -> str:
        try:
            return api_fetch(world, method, url, params, body)
        finally:
            save()

    @mcp.tool(name="base64_encode", description=base64_encode.__doc__)
    def encode(text: str) -> str:
        return base64_encode(text)

    mcp.run("stdio")


def grade(task_path: str, world_path: str) -> None:
    from automationbench.rubric import partial_credit, task_completed_correctly
    from automationbench.schema.world import WorldState

    task = load_task(task_path)
    world, initial = initial_world(task)
    acted = Path(world_path).exists()
    if acted:
        world = WorldState(**json.loads(Path(world_path).read_text(encoding="utf-8")))
    state = {
        "info": copy.deepcopy(task["info"]),
        "world": world,
        "initial_state": copy.deepcopy(initial),
    }
    from automationbench.runner import strip_none_values

    state["info"]["assertions"] = [strip_none_values(a) for a in state["info"].get("assertions", [])]
    credit = partial_credit(state)
    passed = task_completed_correctly(state)
    print(json.dumps({"partial_credit": credit, "passed": passed == 1.0, "acted": acted}))


if __name__ == "__main__":
    command, *args = sys.argv[1:]
    {"prepare": prepare, "serve": serve, "grade": grade}[command](*args)
