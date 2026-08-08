"""Write guard for sandbox scripts.

`sandbox/` is on PYTHONPATH for every sandbox run, so Python's `site` imports this module
automatically at interpreter startup — before the agent's script gets a chance to write
anything. It refuses writes whose resolved target sits outside `sandbox/`.

This is protection against mistakes, not a security boundary. A script that shells out, or
writes through a C extension, goes around it. Reads are deliberately unrestricted: sandbox
scripts are meant to read plans/, catalogs/ and memory/.

Nothing here touches importlib's bytecode writer: it holds direct references to the raw
`nt`/`posix` module and `_io`, not to the `os` and `builtins` names patched below, so
__pycache__ still works.
"""

import builtins
import os
import shutil
import sys
import tempfile

_SANDBOX = os.environ.get("CBC_SANDBOX_ROOT")
if _SANDBOX:
    _ROOTS = [os.path.realpath(_SANDBOX), os.path.realpath(tempfile.gettempdir())]

    _WRITE_FLAGS = ("w", "a", "x", "+")

    class SandboxWriteError(PermissionError):
        """Raised when a sandbox script tries to write outside sandbox/."""

    def _allowed(path) -> bool:
        try:
            resolved = os.path.realpath(os.fspath(path))
        except TypeError:          # file descriptor, or something not path-like
            return True
        return any(
            resolved == root or resolved.startswith(root + os.sep) for root in _ROOTS
        )

    def _check(path, what: str):
        if not _allowed(path):
            raise SandboxWriteError(
                f"sandbox: {what} outside the sandbox is not allowed -> {path}\n"
                f"Write under CBC_OUTPUTS_ROOT or the working directory instead. "
                f"Workspace files (plans/, catalogs/, memory/, .agent/) are read-only here."
            )

    def _guard_path_arg(func, what: str, argno: int = 0):
        def wrapper(*args, **kwargs):
            if len(args) > argno:
                _check(args[argno], what)
            return func(*args, **kwargs)
        wrapper.__name__ = getattr(func, "__name__", what)
        return wrapper

    _real_open = builtins.open

    def _guarded_open(file, mode="r", *args, **kwargs):
        if any(f in mode for f in _WRITE_FLAGS):
            _check(file, f"open({mode!r})")
        return _real_open(file, mode, *args, **kwargs)

    builtins.open = _guarded_open

    for _mod, _name, _what, _argno in (
        (os, "remove", "remove", 0),
        (os, "unlink", "unlink", 0),
        (os, "rmdir", "rmdir", 0),
        (os, "mkdir", "mkdir", 0),
        (os, "makedirs", "makedirs", 0),
        (os, "rename", "rename", 1),        # guard the destination
        (os, "replace", "replace", 1),
        (shutil, "rmtree", "rmtree", 0),
        (shutil, "move", "move", 1),
        (shutil, "copy", "copy", 1),
        (shutil, "copy2", "copy2", 1),
        (shutil, "copyfile", "copyfile", 1),
    ):
        setattr(_mod, _name, _guard_path_arg(getattr(_mod, _name), _what, _argno))

    # `os.rename`/`os.replace` also move things *out* of the sandbox by source; check both.
    for _name in ("rename", "replace"):
        _fn = getattr(os, _name)

        def _both(*args, __fn=_fn, __what=_name, **kwargs):
            if args:
                _check(args[0], f"{__what} (source)")
            return __fn(*args, **kwargs)

        setattr(os, _name, _both)

    sys.modules.setdefault("cbc_sandbox_guard", sys.modules[__name__])
