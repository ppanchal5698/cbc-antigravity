"""
Agent Sandbox Runner
Executes agent scripts safely within sandbox/workspace using the workspace .venv Python environment.
"""

from __future__ import annotations
import os
import sys
import subprocess
import time
from pathlib import Path
from typing import Dict, Any, Optional

# Base directories
SANDBOX_DIR = Path(__file__).parent.resolve()
ROOT_DIR = SANDBOX_DIR.parent.resolve()
SCRIPTS_DIR = SANDBOX_DIR / "scripts"
WORKSPACE_DIR = SANDBOX_DIR / "workspace"
OUTPUTS_DIR = SANDBOX_DIR / "outputs"


def _venv_python() -> str:
    """The workspace interpreter, or this one. Windows layout first, then POSIX."""
    for candidate in (ROOT_DIR / ".venv" / "Scripts" / "python.exe",
                      ROOT_DIR / ".venv" / "bin" / "python3",
                      ROOT_DIR / ".venv" / "bin" / "python"):
        if candidate.exists():
            return str(candidate)
    return sys.executable

# Ensure directories exist
SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)


def run_sandbox_script(
    script_name: str,
    code_content: Optional[str] = None,
    args: Optional[list[str]] = None,
    timeout_seconds: int = 30,
) -> Dict[str, Any]:
    """
    Executes a script inside the isolated sandbox workspace.
    
    Args:
        script_name: Name of the script file (e.g. 'parse_custom_doors.py')
        code_content: Optional Python code content to write before execution
        args: Optional list of CLI arguments to pass to the script
        timeout_seconds: Maximum allowed execution time in seconds
    
    Returns:
        Dict containing success status, exit_code, stdout, stderr, duration_ms, and created_files.
    """
    if not script_name.endswith(".py"):
        script_name += ".py"
    
    script_path = SCRIPTS_DIR / script_name
    
    if code_content is not None:
        script_path.write_text(code_content, encoding="utf-8")
    elif not script_path.exists():
        return {
            "success": False,
            "error": f"Script '{script_name}' does not exist in {SCRIPTS_DIR} and no code_content was provided.",
            "exit_code": 1,
            "stdout": "",
            "stderr": f"FileNotFoundError: {script_path}",
            "created_files": [],
        }

    # Snapshot existing files before the run. Compared against st_mtime afterwards, so it
    # has to be wall-clock: perf_counter is time since an arbitrary epoch and every mtime
    # compares greater than it, which reported every file as newly created on every run.
    before = {
        p: p.stat().st_mtime
        for p in (set(WORKSPACE_DIR.rglob("*")) | set(OUTPUTS_DIR.rglob("*")))
        if p.is_file()
    }

    python_exe = _venv_python()

    # SANDBOX_DIR is first on PYTHONPATH so `site` picks up sandbox/sitecustomize.py at
    # interpreter startup — that is what installs the write guard, before the script runs.
    env = os.environ.copy()
    pythonpath_entries = [
        str(SANDBOX_DIR),
        str(ROOT_DIR / ".agent" / "mcp" / "building-plan-intelligence"),
        str(ROOT_DIR / ".agent" / "mcp" / "catalog-intelligence"),
        str(ROOT_DIR / ".agent" / "mcp" / "cbc-estimating-engine"),
        str(ROOT_DIR),
    ]
    env["PYTHONPATH"] = os.pathsep.join(pythonpath_entries)
    env["CBC_SANDBOX_ROOT"] = str(SANDBOX_DIR)
    env["CBC_WORKSPACE_ROOT"] = str(ROOT_DIR)
    env["CBC_SANDBOX_WORKSPACE"] = str(WORKSPACE_DIR)
    env["CBC_OUTPUTS_ROOT"] = str(OUTPUTS_DIR)
    env.pop("PYTHONNOUSERSITE", None)

    cmd = [python_exe, str(script_path)]
    if args:
        cmd.extend(args)

    start_time = time.perf_counter()
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(WORKSPACE_DIR),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
        
        all_current = [
            p for p in (set(WORKSPACE_DIR.rglob("*")) | set(OUTPUTS_DIR.rglob("*")))
            if p.is_file() and p.name != ".gitkeep"
        ]
        touched = [
            str(p.relative_to(SANDBOX_DIR))
            for p in all_current
            if p not in before or p.stat().st_mtime > before[p]
        ]

        return {
            "success": proc.returncode == 0,
            "script_name": script_name,
            "script_path": str(script_path),
            "exit_code": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "duration_ms": duration_ms,
            "created_files": sorted(touched),
            "all_sandbox_files": sorted([str(p.relative_to(SANDBOX_DIR)) for p in all_current]),
            "working_directory": str(WORKSPACE_DIR),
        }

    except subprocess.TimeoutExpired:
        duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
        return {
            "success": False,
            "script_name": script_name,
            "script_path": str(script_path),
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Execution timed out after {timeout_seconds} seconds.",
            "duration_ms": duration_ms,
            "created_files": [],
            "working_directory": str(WORKSPACE_DIR),
        }
    except Exception as exc:
        duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
        return {
            "success": False,
            "script_name": script_name,
            "script_path": str(script_path),
            "exit_code": 1,
            "stdout": "",
            "stderr": str(exc),
            "duration_ms": duration_ms,
            "created_files": [],
            "working_directory": str(WORKSPACE_DIR),
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python runner.py <script_name> [args...]")
        sys.exit(1)
    
    script = sys.argv[1]
    extra_args = sys.argv[2:]
    res = run_sandbox_script(script, args=extra_args)
    print(f"Status: {'SUCCESS' if res['success'] else 'FAILED'} (Exit code: {res['exit_code']})")
    print(f"Duration: {res['duration_ms']} ms")
    if res["created_files"]:
        print(f"Created Files: {', '.join(res['created_files'])}")
    if res["stdout"]:
        print("\n--- STDOUT ---")
        print(res["stdout"])
    if res["stderr"]:
        print("\n--- STDERR ---")
        print(res["stderr"])
