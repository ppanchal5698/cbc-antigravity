"""Estimator-verified prices, which outrank anything the parsers produce.

No parser is right every time. This shelf has proved it: a baby changing station parsed
at $2.45 because the real $1,537.20 sat in a column the price pattern could not see, and
a grab bar read as $68,616.99 when a model number ran into the price beside it. Both are
fixed, and the next book will find a new way to be misread.

So there has to be somewhere a person can put the correct number and have it win. That
is this file.

**It lives in `memory/`, not in `.agent/cache/`.** The cache is gitignored and
documented as "rebuilt on demand" - deleting it is supposed to cost one re-index and
nothing else. A verified price is not derivable from the PDFs, so losing it with the
cache would be losing real work. `memory/price_overrides.jsonl` is versioned, diffable,
and follows the same shape as the `memory/corrections.jsonl` that is already there.
"""

import json
import os
from datetime import datetime, timezone

FILENAME = "price_overrides.jsonl"

# What an override has to carry to be usable. `source` is not optional: an unattributed
# price is exactly the thing this file exists to replace.
REQUIRED = ("vendor", "model", "price", "price_basis", "source")


def _workspace_root():
    root = os.environ.get("CBC_WORKSPACE_ROOT")
    if root and os.path.isdir(os.path.join(root, "memory")):
        return root
    here = os.path.abspath(__file__)
    for _ in range(8):
        here = os.path.dirname(here)
        if os.path.isdir(os.path.join(here, "memory")):
            return here
    return os.getcwd()


def path():
    return os.path.join(_workspace_root(), "memory", FILENAME)


_CACHE = {"stamp": None, "rows": []}


def _stamp(file_path):
    try:
        st = os.stat(file_path)
        return f"{st.st_mtime_ns}:{st.st_size}"
    except OSError:
        return None


def load(force=False):
    """Every override on file, newest last. Cached on the file's own mtime."""
    file_path = path()
    stamp = _stamp(file_path)
    if not force and stamp == _CACHE["stamp"]:
        return _CACHE["rows"]
    rows = []
    if stamp is not None:
        with open(file_path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("//"):
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue          # a hand-edited file must not break every lookup
    _CACHE["stamp"], _CACHE["rows"] = stamp, rows
    return rows


def _norm(value):
    return " ".join(str(value or "").strip().upper().split())


def matches(row, vendor, model, size="", finish=""):
    """Does this override apply to one specific size/finish variant?

    An empty size or finish ON THE OVERRIDE means "any variant of this model". A
    populated one has to agree with what the caller asked for.
    """
    if _norm(row.get("vendor")) != _norm(vendor):
        return False
    if _norm(row.get("model")) != _norm(model):
        return False
    for field, value in (("size", size), ("finish", finish)):
        recorded = _norm(row.get(field))
        if recorded and recorded != _norm(value):
            return False
    return True


def for_model(vendor, model):
    """Every override for a model, newest first, whatever variant it names.

    Deliberately NOT filtered by size or finish: `lookup_product` is a model-level
    question - "what does this cost" - and returns every size/finish row there is. An
    override recorded against US26D is part of that answer, and filtering it out on a
    blank finish hid it completely.
    """
    # Position in the file breaks a timestamp tie. Two overrides recorded inside one
    # clock tick - ~15ms on Windows - carry the same `recorded_at`, and a stable sort
    # would then hand back the OLDER one first, which is the opposite of the contract.
    # The file is append-only, so a later line is always the later record.
    hits = [(i, r) for i, r in enumerate(load())
            if _norm(r.get("vendor")) == _norm(vendor)
            and _norm(r.get("model")) == _norm(model)]
    hits.sort(key=lambda pair: (pair[1].get("recorded_at") or "", pair[0]), reverse=True)
    return [r for _, r in hits]


def record(entry):
    """Append one override. Returns the stored record.

    Appended, never rewritten: the history of who changed a price and when is the audit
    trail, and a quote written last month should still be explicable.
    """
    missing = [f for f in REQUIRED if not str(entry.get(f) or "").strip()]
    if missing:
        raise ValueError(f"an override needs {', '.join(missing)}")
    try:
        price = float(entry["price"])
    except (TypeError, ValueError):
        raise ValueError(f"price must be a number, got {entry['price']!r}")
    if price < 0:
        raise ValueError("price cannot be negative")

    record_entry = {
        "vendor": str(entry["vendor"]).strip(),
        "model": str(entry["model"]).strip(),
        "size": str(entry.get("size") or "").strip(),
        "finish": str(entry.get("finish") or "").strip(),
        "price": round(price, 4),
        "price_basis": str(entry["price_basis"]).strip().lower(),
        "source": str(entry["source"]).strip(),
        "confirmed_by": str(entry.get("confirmed_by") or "").strip(),
        "effective_date": str(entry.get("effective_date") or "").strip(),
        "note": str(entry.get("note") or "").strip(),
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }
    file_path = path()
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record_entry) + "\n")
    _CACHE["stamp"] = None            # force a reload on the next lookup
    return record_entry
