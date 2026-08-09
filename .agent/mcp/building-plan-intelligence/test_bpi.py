"""Runnable check against the two reference plan sets.

Guards the findings that shaped the design - above all that text extraction
stays in "words" mode. If someone reintroduces get_text("dict"), the timing
assertion fails (Bid Set p60 alone takes 187s+ in dict mode).

    python test_bpi.py [path_to_dutch_bros.pdf path_to_bid_set.pdf]
"""

import base64
import os
import sys
import time

from bpi import index as ix
from bpi import server as sv

# The workspace's own plans/ by default, so this runs from a clone. The reference sets
# the assertions were written against live outside the repo; point BPI_SAMPLES at them
# to reproduce those exact numbers.
_WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SAMPLES = os.environ.get("BPI_SAMPLES") or os.path.join(_WORKSPACE, "plans")
DUTCH = os.path.join(SAMPLES, "BUILDING PLANS-Dutch Bros 11-21-25.pdf")
BID = os.path.join(SAMPLES, "Bid Set.pdf")

INDEX_BUDGET_S = 90  # generous; dict mode blows this out by ~3x on one page


def _json(s):
    import json
    return json.loads(s)


def main(dutch=DUTCH, bid=BID):
    for p in (dutch, bid):
        if not os.path.exists(p):
            print(f"SKIP: missing {p}")
            return

    t0 = time.time()
    d = _json(sv.open_plan_set(dutch))
    b = _json(sv.open_plan_set(bid))
    elapsed = time.time() - t0
    assert elapsed < INDEX_BUDGET_S, (
        f"indexing took {elapsed:.0f}s (budget {INDEX_BUDGET_S}s) - "
        "did text extraction switch away from words mode?")

    # Dutch Bros is born-digital: every sheet identifiable, nothing needs vision.
    assert d["pages"] == 65, d["pages"]
    assert d["vision_need"]["none"] == 65, d["vision_need"]
    assert d["sheet_size_in"] == "36.0x24.0", d["sheet_size_in"]

    sheets = _json(sv.list_sheets(d["doc_id"]))
    by_page = {s["page"]: s for s in sheets}
    assert by_page[1]["sheet"] == "G0.0", by_page[1]
    assert by_page[13]["sheet"] == "A2.0", by_page[13]
    assert by_page[13]["title"] == "FLOOR PLAN", by_page[13]
    assert by_page[13]["discipline"] == "Architectural", by_page[13]
    assert all(s["sheet"] for s in sheets), "every Dutch Bros sheet must be identified"

    # Bid Set exercises the vision path: outlined text, two distinct gaps.
    assert b["pages"] == 87, b["pages"]
    assert b["vision_need"]["full"] >= 20, b["vision_need"]
    assert b["vision_need"]["identity"] >= 20, b["vision_need"]

    ov = _json(sv.plan_overview(b["doc_id"]))
    assert ov["needs_vision_full"], "expected pages with no text layer"
    assert "render_sheet" in ov["next_step"]

    # search finds real content on a texted sheet
    hits = _json(sv.search_sheets(d["doc_id"], "floor plan"))
    assert hits["hits"] > 0, hits

    # rendering: a tile must come back as real PNG bytes
    out = sv.render_sheet(b["doc_id"], str(ov["needs_vision_full"][0]), tile="r1c2")
    imgs = [c for c in out if getattr(c, "type", None) == "image"]
    assert len(imgs) == 1, out
    png = base64.b64decode(imgs[0].data)
    assert png[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    assert len(png) > 5000, len(png)

    # default grid returns every tile
    full = sv.render_sheet(d["doc_id"], "A2.0")
    assert len([c for c in full if getattr(c, "type", None) == "image"]) == 6

    # vision write-back closes the loop: unreadable page becomes searchable
    page = ov["needs_vision_full"][0]
    rec = _json(sv.record_vision_reading(
        b["doc_id"], str(page),
        "sheet_no=A9.9 GRAVEL BED UNDERDRAIN DETAIL zzqmarker", tile="r1c2"))
    assert rec["sheet_no_set"] == "A9.9", rec
    found = _json(sv.search_sheets(b["doc_id"], "zzqmarker"))
    assert found["hits"] == 1, found
    assert found["results"][0]["page"] == page, found
    assert found["results"][0]["found_in"].startswith("vision"), found
    assert found["results"][0]["sheet"] == "A9.9", found

    # --- accuracy guards -------------------------------------------------
    # Every case below is a real error a model made reading this set, or the
    # ground truth it got wrong. These are the regressions that matter.

    # 1. Schedules must come back as rows, with NO row dropped. The door
    #    schedule numbering skips: 01, 02, 03, 06.
    sched = _json(sv.read_schedule(d["doc_id"], "A2.2"))
    assert sched["tables_found"] >= 5, sched["tables_found"]
    door_tbl = [t for t in sched["tables"]
                if any(r and r[0] == "01" for r in t["rows"])]
    assert door_tbl, "door schedule table not found on A2.2"
    tags = [r[0] for r in door_tbl[0]["rows"] if r and r[0] in
            ("01", "02", "03", "04", "05", "06")]
    assert tags == ["01", "02", "03", "06"], f"door rows wrong: {tags}"

    # 2. verify_facts must reject what is not in the document and accept what
    #    is — including values that differ only in a digit.
    checks = {
        "VON DURPIN 99EO, 26": True,     # the real Group 2 panic device
        "VON DUPRIN 99EO 36": False,     # plausible, wrong, and was reported
        "Alarm Lock Trilogy": False,     # brand line absent from the set
        "ETDL27R1G/26DV 99": True,
        "recessed mounting kit": True,   # Knox box IS recessed
        "#4 satin finish": False,        # contradicts "Finish: 2D, dull"
        "Kawneer Trifab VG 451T": True,  # quoted in the spec
        "KAWNEER 541T": True,            # the conflicting note on A2.2
    }
    vf = _json(sv.verify_facts(d["doc_id"], list(checks)))
    got = {r["claim"]: r["verified"] for r in vf["results"]}
    wrong = {k: (v, got[k]) for k, v in checks.items() if got[k] != v}
    assert not wrong, f"verify_facts mismatches (expected, got): {wrong}"

    # 3. cross_reference must surface a spec-vs-schedule conflict, not hide it.
    xr = _json(sv.cross_reference(d["doc_id"], "KAWNEER"))
    ctx = " ".join(c for o in xr["results"] for c in o["context"])
    assert "451T" in ctx and "541T" in ctx, "conflicting Kawneer series not surfaced"
    assert xr["sheets_mentioning"] >= 2, xr["sheets_mentioning"]

    # 4. get_sheet must warn when a sheet carries tables.
    gs = _json(sv.get_sheet(d["doc_id"], "A2.2"))
    assert gs["tables_on_sheet"] > 0 and "read_schedule" in gs.get("warning", "")

    # 5. stdout must stay pristine. This server speaks JSON-RPC over stdout;
    #    PyMuPDF prints a layout-package hint from find_tables(), and one stray
    #    line kills the client connection. Guard it.
    import io
    import contextlib as _ctx
    buf = io.StringIO()
    with _ctx.redirect_stdout(buf):
        sv.read_schedule(d["doc_id"], "A2.2")
        sv.get_sheet(d["doc_id"], "A2.2")
    leaked = buf.getvalue()
    assert leaked == "", f"stdout polluted, would corrupt JSON-RPC: {leaked[:120]!r}"

    print(f"OK  indexed 152 sheets in {elapsed:.1f}s")
    print(f"    Dutch Bros: 65/65 identified, 0 need vision")
    print(f"    Bid Set:    {b['vision_need']['full']} no-text, "
          f"{b['vision_need']['identity']} no-title-block")
    print(f"    A2.2 door schedule rows: {tags}  (numbering skips - all present)")
    print(f"    verify_facts: {len(checks)}/{len(checks)} correct verdicts")
    print(f"    cross_reference: Kawneer 451T/541T conflict surfaced")


if __name__ == "__main__":
    args = sys.argv[1:]
    main(*(args if len(args) == 2 else ()))
