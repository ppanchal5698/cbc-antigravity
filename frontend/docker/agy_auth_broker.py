#!/usr/bin/env python3
"""Headless OAuth broker for the Antigravity CLI (`agy`).

`agy -p` (print mode) gives the OAuth prompt only 30 s — too short for a
human-in-the-loop login from the browser. `agy -i` (interactive TUI) has no
auth timeout but must be driven through a pseudo-terminal.

This broker spawns `agy -i` under a pty, answers terminal capability queries so
the TUI renders, auto-selects "Google OAuth", scrapes the auth URL, and feeds
back an authorization code written to the state directory by the gateway.

Fake SSH env vars force file-based token storage
(`~/.gemini/antigravity-cli/antigravity-oauth-token`) instead of the OS
keyring, which is unreliable in containers.

State directory (AGY_BROKER_DIR, default /tmp/agybroker): url, code, status, log.
"""
from __future__ import annotations

import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# CSI / OSC and other common ANSI sequences the TUI sprays around the URL.
_ANSI_RE = re.compile(
    rb"(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))"  # OSC
    rb"|(?:\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))"  # CSI / Fe
)
_URL_START_RE = re.compile(
    rb"https://accounts\.google\.com/o/oauth2/(?:v2/)?auth\?"
)


def strip_ansi(data: bytes) -> bytes:
    return _ANSI_RE.sub(b"", data)


def sanitize_oauth_url(url: str) -> str:
    """Drop whitespace and collapse duplicate query keys (keep first).

    The agy TUI hard-wraps the URL and redraws with ``\\r``; a naive scrape can
    therefore emit ``code_challenge_method`` twice, which Google rejects with
    Error 400 invalid_request.
    """
    cleaned = re.sub(r"\s+", "", url.strip())
    parts = urlsplit(cleaned)
    if not parts.scheme or not parts.netloc:
        return cleaned
    params: list[tuple[str, str]] = []
    seen: set[str] = set()
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key in seen:
            continue
        seen.add(key)
        params.append((key, value))
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(params, safe=":/"), parts.fragment)
    )


def extract_oauth_url(buf: bytes) -> bytes | None:
    """Return a clean Google OAuth URL from pty output, or None.

    Reconstructs the URL across TUI hard-wraps (newlines + padding spaces) and
    ignores cursor-reset redraws that would otherwise duplicate query params.
    """
    text = strip_ansi(buf).replace(b"\r", b"\n")
    m = _URL_START_RE.search(text)
    if not m:
        return None

    # Take from the URL start through the next blank / box-drawing / prompt line.
    tail = text[m.start() :].decode("utf-8", errors="ignore")
    chunks: list[str] = []
    for raw_line in tail.split("\n"):
        line = raw_line.strip()
        if not line:
            if chunks:
                break
            continue
        # Box borders / labels around the URL block.
        if line.startswith(("─", "═", "┌", "└", "│")):
            if chunks:
                break
            continue
        if chunks and not re.match(r"^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$", line):
            break
        # A second full URL means the TUI redrew; stop before duplicating.
        if chunks and line.startswith("https://"):
            break
        chunks.append(line)
        candidate = sanitize_oauth_url("".join(chunks))
        # Enough to be useful: must include PKCE method once we have a full wrap set.
        if "code_challenge_method=" in candidate and "state=" in candidate:
            return candidate.encode("utf-8")

    if not chunks:
        return None
    candidate = sanitize_oauth_url("".join(chunks))
    if "accounts.google.com" in candidate and "code_challenge" in candidate:
        return candidate.encode("utf-8")
    return None


def capability_replies(data: bytes) -> bytes:
    """Answer TUI terminal capability queries so it stops waiting."""
    out = b""
    for mode_n in (2026, 2027, 1016, 1049):
        if (b"\x1b[?%d$p" % mode_n) in data:
            out += b"\x1b[?%d;2$y" % mode_n
    if b"\x1b[c" in data or b"\x1b[>c" in data or b"\x1b[>0c" in data:
        out += b"\x1b[?62;1;6c"
    if b"\x1b[6n" in data:
        out += b"\x1b[1;1R"
    return out


def main() -> None:
    state_dir = os.environ.get("AGY_BROKER_DIR", "/tmp/agybroker")
    os.makedirs(state_dir, exist_ok=True)
    log_p, url_p, code_p, status_p = (
        f"{state_dir}/{n}" for n in ("log", "url", "code", "status")
    )
    for path in (log_p, url_p, code_p, status_p):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass

    prompt = sys.argv[1] if len(sys.argv) > 1 else "reply with the single word OK"
    agy = os.environ.get("AGY_BIN") or os.path.expanduser("~/.local/bin/agy")
    if not os.path.isabs(agy) and not os.path.exists(agy):
        # Resolve from PATH when AGY_BIN is just "agy".
        for directory in os.environ.get("PATH", "").split(os.pathsep):
            candidate = os.path.join(directory, "agy")
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                agy = candidate
                break

    def status(s: str) -> None:
        with open(status_p, "w", encoding="utf-8") as fh:
            fh.write(s + "\n")

    status("starting")
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        local_bin = os.path.expanduser("~/.local/bin")
        os.environ["PATH"] = local_bin + ":" + os.environ.get("PATH", "")
        # SSH env => agy uses file-based token storage, not the D-Bus keyring.
        os.environ.setdefault("SSH_CONNECTION", "203.0.113.1 50000 203.0.113.2 22")
        os.environ.setdefault("SSH_CLIENT", "203.0.113.1 50000 22")
        os.environ.setdefault("SSH_TTY", "/dev/pts/0")
        os.execv(agy, [agy, "-i", prompt])
        os._exit(1)

    # Wide pty so a ~400-char URL is never line-wrapped.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))

    buf = b""
    log = open(log_p, "wb")
    url_done = code_sent = menu_done = False
    start = time.time()
    status("running")
    try:
        while True:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 8192)
                except OSError:
                    data = b""
                if not data:
                    break
                buf += data
                log.write(data)
                log.flush()
                reply = capability_replies(data)
                if reply:
                    os.write(fd, reply)
                # Menu: "Google OAuth" is option 1, already highlighted -> Enter.
                if not menu_done and b"Select login method" in buf:
                    time.sleep(0.4)
                    os.write(fd, b"\r")
                    menu_done = True
                    status("oauth-selected")
                if not url_done:
                    url = extract_oauth_url(buf)
                    if url:
                        with open(url_p, "wb") as fh:
                            fh.write(url)
                        url_done = True
                        status("url-ready")
                if not code_sent and os.path.exists(code_p):
                    with open(code_p, "rb") as fh:
                        code = fh.read().strip()
                    if code:
                        os.write(fd, code + b"\r")
                        code_sent = True
                        status("code-sent")
            if time.time() - start > 1200:
                break
    finally:
        log.close()
        status("exited")


if __name__ == "__main__":
    main()
