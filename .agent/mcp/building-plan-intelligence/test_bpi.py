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


def _check_layout_independence(d, b):
    """Every plan set is numbered and laid out differently.

    These assertions deliberately name no sheet number. A test that says "the door
    schedule is on A2.2" encodes the assumption this whole pass exists to remove; what
    matters is that discovery FINDS it, whatever the set calls it.
    """
    for doc in (d, b):
        did = doc["doc_id"]
        ov = _json(sv.plan_overview(did))

        # 1. No sheet may go missing between "needs a look" and the list the Phase 3 gate
        # reads. An allow list on discipline used to drop every unnumbered sheet - 52 of
        # the Bid Set's 87 - after flagging them as needing vision.
        con = ix.connect()
        try:
            required = con.execute(
                "SELECT page, discipline FROM sheets WHERE doc_id=? AND "
                "vision_status='required'", (did,)).fetchall()
        finally:
            con.close()
        listed = {o["page"] for o in ov["vision_outstanding"]}
        for page, disc in required:
            assert page in listed or disc in ix.OUT_OF_SCOPE_DISCIPLINES, (
                f"p{page} ({disc}) needs vision but is absent from vision_outstanding")

        # 2. An unnumbered sheet is reported, never silently swallowed.
        assert "unidentified" in ov, "plan_overview must report what it could not name"
        assert ov["unidentified"]["count"] == len(
            [1 for _ in ov["unidentified"]["pages"]]) or ov["unidentified"]["count"] > 40

        # 3. Absence is never asserted while anything is still unread. This is the
        # "silence is not evidence" rule: a set can extract text on every sheet and still
        # hide a schedule drawn as outlined text.
        for kind in ("door", "accessory", "finish"):
            fs = _json(sv.find_schedule(did, kind, read_tables=False))
            assert "not_searchable" in fs and "unread_drawings" in fs, fs.keys()
            if not fs.get("candidates"):
                unseen = fs["not_searchable"]["count"] + fs["unread_drawings"]["count"]
                assert fs["absence_established"] == (unseen == 0), (
                    f"{kind}: claimed absence with {unseen} sheets unread")

    # 4. Discovery finds the door schedule in the born-digital set without being told
    # where to look, and ranks the schedule above sheets that merely reference it.
    fs = _json(sv.find_schedule(d["doc_id"], "door", read_tables=False))
    assert fs["candidates"], "door schedule not found by content in Dutch Bros"
    top = fs["candidates"][0]
    assert len(top["matched"]) >= 3, (
        f"top candidate matched only {top['matched']} - ranking is counting repeats of one "
        "phrase (a detail sheet saying 'SEE DOOR SCHEDULE') over real column vocabulary")
    tables = _json(sv.read_schedule(d["doc_id"], str(top["page"])))
    assert tables.get("tables_found", 0) > 0, "the winning sheet holds no readable table"

    # 5. A sheet number from another firm's convention degrades to near misses instead of
    # a bare error. `A-202` is how a different office writes `A2.2`.
    miss = _json(sv.get_sheet(d["doc_id"], "ZZ-999"))
    assert "error" in miss and miss.get("did_you_mean"), miss
    assert ix.resolve_page.__doc__, "resolve_page must document its fallback"
    con = ix.connect()
    try:
        real = con.execute(
            "SELECT sheet_no FROM sheets WHERE doc_id=? AND sheet_no IS NOT NULL LIMIT 1",
            (d["doc_id"],)).fetchone()[0]
        squashed = real.replace(".", "-")          # A2.2 -> A2-2
        assert ix.resolve_page(con, d["doc_id"], squashed) is not None, (
            f"punctuation-insensitive lookup failed for {squashed!r} vs {real!r}")
    finally:
        con.close()

    print(f"    layout independence: gate coverage, honest absence, "
          f"content discovery (top match {len(top['matched'])} distinct terms)")


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

    # Dutch Bros is born-digital: every sheet identifiable. That used to mean "nothing
    # needs vision", and this file asserted it - which is exactly the bug. A text layer
    # says the page can be read, not that its meaning is written down. Quantities, sizes
    # and tag counts on a plan or an elevation are geometry, so every in-scope drawing
    # needs a visual pass however cleanly it extracted.
    assert d["pages"] == 65, d["pages"]
    assert d["sheet_size_in"] == "36.0x24.0", d["sheet_size_in"]

    sheets = _json(sv.list_sheets(d["doc_id"]))
    by_page = {s["page"]: s for s in sheets}
    assert by_page[1]["sheet"] == "G0.0", by_page[1]
    assert by_page[13]["sheet"] == "A2.0", by_page[13]
    assert by_page[13]["title"] == "FLOOR PLAN", by_page[13]
    assert by_page[13]["discipline"] == "Architectural", by_page[13]
    assert all(s["sheet"] for s in sheets), "every Dutch Bros sheet must be identified"

    # The sheets a takeoff actually reads must be flagged for a visual pass...
    need = {s["sheet"]: s["vision_need"] for s in sheets}
    for sheet in ("A2.0", "A2.2", "A5.1", "A1.1", "A1.2", "A6.1"):
        assert need[sheet] == "drawing", (sheet, need[sheet])
    # ...and prose or out-of-scope disciplines must not be, or every run pays to render
    # 65 sheets to read seven.
    for sheet in ("G1.0", "G1.4", "G0.0", "S2.3", "E1.0", "P1.1"):
        assert need[sheet] == "none", (sheet, need[sheet])

    ov_d = _json(sv.plan_overview(d["doc_id"]))
    assert ov_d["vision_outstanding"], "Phase 3 gate has nothing to hold on"
    assert all(o["sheet_no"] not in ("G1.0", "S2.3") for o in ov_d["vision_outstanding"])

    # A dimension string is not a sheet name. A6.0 came through as `3' - 2"`, A7.1 as
    # `-0' - 6"` and S2.1 as the copyright line, and nothing flagged any of them.
    import re as _re
    for s in sheets:
        t = s.get("title") or ""
        assert not _re.match(r"^\s*-?\d+'\s*-", t), f"{s['sheet']}: dimension stored as title: {t!r}"
        assert "Franchising" not in t, f"{s['sheet']}: copyright stored as title: {t!r}"

    # Bid Set exercises the vision path: outlined text, three distinct gaps. `full` is
    # "no text at all", `identity` is "searchable but unnamed", `drawing` is "named and
    # searchable, but its meaning is geometry". They need different remedies, so a set
    # that loses the distinction has regressed even if the totals look fine.
    assert b["pages"] == 87, b["pages"]
    assert b["vision_need"]["full"] >= 20, b["vision_need"]
    assert b["vision_need"]["identity"] >= 1, b["vision_need"]
    unread_b = sum(b["vision_need"][k] for k in ("full", "identity", "drawing"))
    assert unread_b >= 50, (unread_b, b["vision_need"])

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

    # verify_facts caches this document's normalized text. Warm that cache BEFORE the
    # vision write below, so the assertion afterwards is about invalidation and not about
    # a cache that happened to be cold.
    pre = _json(sv.verify_facts(b["doc_id"], ["zzqmarker"]))
    assert pre["results"][0]["verified"] is False, pre

    # vision write-back closes the loop: unreadable page becomes searchable
    page = ov["needs_vision_full"][0]
    rec = _json(sv.record_vision_reading(
        b["doc_id"], str(page),
        "sheet_no=A9.9 GRAVEL BED UNDERDRAIN DETAIL zzqmarker", tile="r1c2"))
    assert rec["sheet_no_set"] == "A9.9", rec

    # ...and verify_facts must see it too. It reads a normalized cache keyed on doc_id,
    # and doc_id hashes the FILE - which has not changed - so without an explicit
    # invalidation the claim this vision pass was taken to confirm came back
    # `verified: false`, and building-plan-rules §4 says to delete a false claim.
    post = _json(sv.verify_facts(b["doc_id"], ["zzqmarker"]))
    assert post["results"][0]["verified"] is True, post
    assert post["results"][0]["found_on"][0]["page"] == page, post

    # ...but it must not read as if the DOCUMENT said it. This text is the model's own
    # transcription of a tile, written back into the index. It verifies - on an outlined
    # sheet it is the only evidence there will ever be - and it cannot corroborate the
    # reader who wrote it. Reported identically to a text-layer hit, a hallucinated model
    # number recorded during a vision pass stays "verified" for the life of the index.
    assert post["results"][0]["verified_by"] == "vision_reading", post
    assert "caution" in post["results"][0], post
    assert "zzqmarker" in post["verified_only_by_vision_reading"], post
    assert "[drawing]" in post["note"], post

    # A claim that IS in the text layer keeps the strong label.
    doc_claim = _json(sv.verify_facts(d["doc_id"], ["FLOOR PLAN"]))
    assert doc_claim["results"][0]["verified"] is True, doc_claim
    assert doc_claim["results"][0]["verified_by"] == "document", doc_claim
    assert "caution" not in doc_claim["results"][0], doc_claim
    assert not doc_claim["verified_only_by_vision_reading"], doc_claim
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
    _check_layout_independence(d, b)

    print(f"    Dutch Bros: 65/65 identified, "
          f"{len(ov_d['vision_outstanding'])} in-scope drawings need a visual read")
    print(f"    Bid Set:    {b['vision_need']['full']} no-text, "
          f"{b['vision_need']['identity']} no-title-block")
    print(f"    A2.2 door schedule rows: {tags}  (numbering skips - all present)")
    print(f"    verify_facts: {len(checks)}/{len(checks)} correct verdicts")
    print(f"    cross_reference: Kawneer 451T/541T conflict surfaced")


# ---------------------------------------------------------------------------
# pytest entry points
#
# Everything above is one long script with a `main()`, and pytest collects on the `test_`
# prefix - so `pytest .agent/mcp`, the command AGENTS.md documents as THE test command,
# collected ZERO tests from this server and said so only as a count nobody reads. The
# engine and catalog suites ran; the plan server, which owns schedules, vision and
# verify_facts, ran nothing.
#
# `main()` also needs two reference sets that live outside the repo, so it cannot be the
# only coverage. The contract test below runs against whatever plan PDF the workspace
# actually has.
# ---------------------------------------------------------------------------

def test_reference_plan_sets():
    """The full script, when the reference sets are available (BPI_SAMPLES)."""
    import pytest
    for p in (DUTCH, BID):
        if not os.path.exists(p):
            pytest.skip(f"reference plan set not present: {os.path.basename(p)}")
    main()


def _any_workspace_plan():
    if not os.path.isdir(SAMPLES):
        return None
    pdfs = sorted(f for f in os.listdir(SAMPLES) if f.lower().endswith(".pdf"))
    if not pdfs:
        return None
    return os.path.join(SAMPLES, min(pdfs, key=lambda f: os.path.getsize(
        os.path.join(SAMPLES, f))))


def test_vision_reading_verifies_but_is_labelled_as_the_readers_own(tmp_path):
    """Two defects, one contract, and they pull in opposite directions.

    A vision reading MUST verify: on a sheet whose text was outlined to vectors it is the
    only evidence that will ever exist, and verify_facts answering `false` has the rules
    order a correctly-read fact deleted. It also must NOT read as though the document said
    it - it is the model's own transcription, saved back into the index, so a hallucinated
    model number recorded during a vision pass stayed 'verified' for the life of the cache.

    Runs against a throwaway BPI_CACHE. Writing a marker into the shared index would leave
    a sheet flagged `vision_status='recorded'` that nobody actually read, which is exactly
    the lie the Phase 3 gate reads.
    """
    import pytest
    plan = _any_workspace_plan()
    if plan is None:
        pytest.skip(f"no plan PDF in {SAMPLES}")

    os.environ["BPI_CACHE"] = str(tmp_path)
    doc = _json(sv.open_plan_set(plan))
    doc_id = doc["doc_id"]
    ix.invalidate_norm_cache(doc_id)      # _NORM_CACHE is keyed on doc_id, not on the DB

    marker = "zzq_vision_contract_marker"

    # Warm the cache first, so what follows tests invalidation and not a cold read.
    assert _json(sv.verify_facts(doc_id, [marker]))["results"][0]["verified"] is False

    con = ix.connect()
    try:
        page, body = con.execute(
            "SELECT page, body FROM sheet_text WHERE doc_id=? AND source='pdf' "
            "AND length(body) > 200 LIMIT 1", (doc_id,)).fetchone()
    finally:
        con.close()

    sv.record_vision_reading(doc_id, str(page), f"{marker} read off a rendered tile")
    after = _json(sv.verify_facts(doc_id, [marker]))["results"][0]

    # BUG-02: the write must be visible to the tool that gates on it.
    assert after["verified"] is True, after
    # SEC-03: ...and must not be indistinguishable from the document's own text.
    assert after["verified_by"] == "vision_reading", after
    assert "caution" in after, after
    assert "[drawing]" in after["caution"], after

    # A claim genuinely in the text layer keeps the strong label. Taken from the indexed
    # body rather than hard-coded, so this does not depend on which set is present.
    phrase = next((w for w in body.split() if len(w) > 6 and w.isalpha()), None)
    if phrase:
        doc_hit = _json(sv.verify_facts(doc_id, [phrase]))["results"][0]
        assert doc_hit["verified"] is True, doc_hit
        assert doc_hit["verified_by"] in ("document", "both"), doc_hit
        assert "caution" not in doc_hit, doc_hit


if __name__ == "__main__":
    args = sys.argv[1:]
    main(*(args if len(args) == 2 else ()))
