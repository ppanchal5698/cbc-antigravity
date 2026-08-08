# Agent sandbox

Where agent-written Python runs: one-off schedule parsers, takeoff simulations, custom
exports. Anything ad-hoc belongs here rather than in the workspace root.

```
scripts/            scripts, written and kept so the estimator can re-run them
workspace/          the execution cwd
outputs/            reports, exported takeoffs, submittal drafts
runner.py           the harness
sitecustomize.py    the write guard, loaded automatically at interpreter startup
```

## Running a script

```bash
python sandbox/runner.py <script_name> [args...]
```

or, from an agent, `execute_sandbox_script(script_name, code_content, args, timeout_seconds)`
on `cbc-estimating-engine`. Either path returns exit code, stdout, stderr, duration, and the
files the run actually touched.

## What the isolation actually does

The runner puts `sandbox/` first on `PYTHONPATH`, so Python's `site` imports
`sitecustomize.py` before the script runs. That patches `open()` in write modes plus
`os.remove/unlink/rename/replace/mkdir/makedirs/rmdir` and the `shutil` write helpers to
resolve their target and raise `PermissionError` unless it lands inside `sandbox/` (or the
system temp directory). An absolute path to `memory/knowledge_graph/graph.json`, or a
`../../` escape, is refused rather than silently corrupting workspace state.

**Reads are unrestricted** — sandbox scripts are meant to read `plans/`, `catalogs/` and
`memory/`.

**This is protection against mistakes, not a security boundary.** A script that shells out,
or writes through a C extension, goes around the guard. Do not run untrusted code here.

## Environment

Scripts run under the workspace `.venv` with `bpi`, `catint`, `cbc_engine`, `fitz`
(PyMuPDF), `pydantic`, `rich` and `pytest` importable, and these variables set:

| Variable | Points at |
|---|---|
| `CBC_WORKSPACE_ROOT` | the CBC workspace root |
| `CBC_SANDBOX_ROOT` | `sandbox/` |
| `CBC_SANDBOX_WORKSPACE` | `sandbox/workspace/` (also the cwd) |
| `CBC_OUTPUTS_ROOT` | `sandbox/outputs/` |

Compose output paths from `CBC_OUTPUTS_ROOT` rather than by hand.

## Tests do not live here

A test for shipped behaviour goes in `.agent/mcp/<server>/test_*.py` and runs under pytest
against the real module:

```bash
.venv/Scripts/python.exe -m pytest .agent/mcp -q
```

This directory previously held four "test suites" that defined the thing they tested inside
the test file — a `PhaseGatekeeper` class, a local domain-containment regex. They passed by
construction and exercised no shipped code. They are gone; their real equivalents are in
`test_engine.py::TestGuardrails`.
