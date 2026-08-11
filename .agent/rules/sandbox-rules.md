---
name: sandbox-rules
description: Where agent-written Python runs, and what the sandbox does and does not protect.
trigger: always_on
---

# Agent sandbox

Ad-hoc Python — a one-off schedule parser, a takeoff simulation, a custom export — belongs
in `sandbox/`, never in the workspace root, `plans/`, `catalogs/`, `memory/` or `.agent/`.

```
sandbox/
├── scripts/     scripts, written and kept
├── workspace/   the execution cwd
├── outputs/     reports and exports
└── runner.py    the harness
```

## Running

`execute_sandbox_script(script_name, code_content, args, timeout_seconds)` via
`cbc-estimating-engine`, or `python sandbox/runner.py <script>` directly. Either way the
runner sets the working directory to `sandbox/workspace/`, runs under the workspace `.venv`,
and returns exit code, stdout, stderr, duration and the files the run actually touched.

## What isolation you get

The runner installs a write guard into the child process: `open()` in any write mode,
`os.remove`, `os.rename` and `shutil` writes are resolved to an absolute path and **refused
unless the target is inside `sandbox/` or the OS temp directory**. An absolute path to
`memory/graph.json` or a `../../` escape raises `PermissionError` rather than corrupting
workspace state.

The temp directory is deliberately allowed — libraries write there routinely and a script
that cannot use `tempfile` is not usable — but it is genuinely outside `sandbox/`, so a
script CAN leave files behind there. Nothing in `sandbox/outputs/` is affected.

`script_name` is checked before any of this. It has to be, because the file is written by
the *server* process, which the guard above never runs in: it names a file directly under
`sandbox/scripts/`, and a path separator, a `..` or an absolute path is refused outright.

That guard covers ordinary Python file writes. It is not a security boundary — a script that
shells out, or writes through a C extension, bypasses it. Treat the sandbox as protection
against mistakes, not against a hostile script. Read access is unrestricted by design:
scripts are meant to read `plans/`, `catalogs/` and `memory/`.

## Imports

Scripts get `bpi`, `catint`, `cbc_engine`, `fitz` (PyMuPDF), `pydantic`, `rich` and `pytest`,
plus these environment variables: `CBC_WORKSPACE_ROOT`, `CBC_SANDBOX_ROOT`,
`CBC_SANDBOX_WORKSPACE`, `CBC_OUTPUTS_ROOT`. Write outputs under `CBC_OUTPUTS_ROOT` rather
than composing paths by hand.

## Tests belong with the code

A test for shipped behaviour goes in `.agent/mcp/<server>/test_*.py` and runs under pytest
against the real module. A test that defines the thing it is testing inside the test file
proves nothing — the sandbox is for exploration, not for the test suite.
