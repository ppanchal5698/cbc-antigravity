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
# OSC 8 hyperlinks are handled separately — they often hold the unbroken URL.
_ANSI_RE = re.compile(
    rb"(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))"  # OSC
    rb"|(?:\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))"  # CSI / Fe
)
_OSC8_URL_RE = re.compile(
    rb"\x1b\]8;[^\x07\x1b]*;(https://accounts\.google\.com/o/oauth2/[^\x07\x1b]+)(?:\x07|\x1b\\)"
)
_REQUIRED_PARAMS = (
    "client_id",
    "response_type",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "state",
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
        (parts.scheme, parts.netloc, parts.path, urlencode(params, doseq=False), parts.fragment)
    )


def is_complete_oauth_url(url: str) -> bool:
    """True only when Google would accept the authorize request."""
    try:
        query = dict(parse_qsl(urlsplit(url).query, keep_blank_values=True))
    except Exception:
        return False
    return all(query.get(key) for key in _REQUIRED_PARAMS)


def extract_oauth_url(buf: bytes) -> bytes | None:
    """Return a clean, complete Google OAuth URL from pty output, or None.

    Prefers OSC 8 hyperlink targets (unwrapped). Falls back to joining the
    hard-wrapped visible text. Never returns a truncated URL — wait for more
    pty data instead (missing response_type is how Google 400s).
    """
    for match in _OSC8_URL_RE.finditer(buf):
        candidate = sanitize_oauth_url(match.group(1).decode("utf-8", errors="ignore"))
        if is_complete_oauth_url(candidate):
            return candidate.encode("utf-8")

    text = strip_ansi(buf).replace(b"\r", b"\n").decode("utf-8", errors="ignore")
    m = re.search(r"https://accounts\.google\.com/o/oauth2/(?:v2/)?auth\?", text)
    if not m:
        return None

    rest = text[m.start() :]
    # Bound the region after the scheme so we don't end on the URL's own https.
    skip = len("https://")
    end = re.search(
        r"\n\s*\n"
        r"|\n\s*[─═\-]{5,}"
        r"|\n\s*(?:Paste|Enter|Authorization code|Waiting)"
        r"|\n\s*https://accounts\.google\.com/o/oauth2/",
        rest[skip:],
        flags=re.IGNORECASE,
    )
    region = rest[: skip + end.start()] if end else rest[:8000]
    collapsed = re.sub(r"\s+", "", region)

    # Keep only URL-safe characters from the start; trim trailing TUI junk.
    url_match = re.match(
        r"(https://accounts\.google\.com/o/oauth2/(?:v2/)?auth\?[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+)",
        collapsed,
    )
    if not url_match:
        return None

    raw = url_match.group(1)
    # If we captured trailing junk past state=, cut after the state value.
    state_cut = re.search(
        r"(https://accounts\.google\.com/o/oauth2/(?:v2/)?auth\?.*?[?&]state=[A-Za-z0-9_\-]+)",
        raw,
    )
    if state_cut:
        raw = state_cut.group(1)

    candidate = sanitize_oauth_url(raw)
    if not is_complete_oauth_url(candidate):
        return None
    return candidate.encode("utf-8")


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
        os.environ["COLUMNS"] = "1000"
        os.environ["LINES"] = "50"
        local_bin = os.path.expanduser("~/.local/bin")
        os.environ["PATH"] = local_bin + ":" + os.environ.get("PATH", "")
        # SSH env => agy uses file-based token storage, not the D-Bus keyring.
        os.environ.setdefault("SSH_CONNECTION", "203.0.113.1 50000 203.0.113.2 22")
        os.environ.setdefault("SSH_CLIENT", "203.0.113.1 50000 22")
        os.environ.setdefault("SSH_TTY", "/dev/pts/0")
        os.execv(agy, [agy, "-i", prompt])
        os._exit(1)

    # Wide pty so a ~400-char URL is never line-wrapped (agy still may hard-wrap).
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
