"""Runnable check against the Hager reference price book.

Guards the parsing facts the design rests on - above all that price rows are
recovered by column geometry, not by find_tables() (which sees only the header)
and not by carry-forward from the row above (description and size are centered
against their block of rows, so carry-forward mispairs them).

    python test_catint.py [path_to_price_book.pdf]
"""

import json
import os
import sys
import time

import fitz

from catint import index as ix
from catint import server as sv

SHELF = "C:/Parth Panchal/mcp-servers/CBC/catalogs"
BOOK = f"{SHELF}/HAGER/Hager Price Book #18 - Complete - Effective 2-2-26.pdf"
# a second vendor, in the flat one-line-per-product layout the header parser
# cannot read - this is what `parse_line_items` exists for
ASI = f"{SHELF}/ASI/ASI-Price-List - 1-12-26 - .375 Multiplier.pdf"

INDEX_BUDGET_S = 60


def main(book=BOOK):
    if not os.path.exists(book):
        print(f"SKIP: missing {book}")
        return

    # --- page-level parsing, before any indexing -------------------------
    doc = fitz.open(book)
    p60 = ix.parse_products(doc[59])          # Commercial Hinges, model 1251
    assert p60, "no price rows parsed from p60"
    assert {r["model"] for r in p60} == {"1251"}, {r["model"] for r in p60}

    # the two size groups must stay separate: same finish, different price
    usp = {r["size"].split(" (")[0]: r["list_price"] for r in p60 if r["finish"] == "USP"}
    assert usp['3-1/2\u201d x 3-1/2\u201d'] == 53.44, usp
    assert usp['4\u201d x 4\u201d'] == 68.08, usp
    # ... and each finish keeps its own price inside a group
    g1 = {r["finish"]: r["list_price"] for r in p60
          if r["size"].startswith("3-1/2")}
    assert g1["US3"] == 67.24 and g1["US26D"] == 61.70, g1

    # find_tables() is NOT a substitute: it sees the header row only.
    import contextlib
    with contextlib.redirect_stdout(sys.stderr):
        tb = doc[59].find_tables()
    assert sum(len(t.extract()) for t in tb.tables) < 3, \
        "find_tables now returns price rows - the column parser may be redundant"

    # p401 groups on a case quantity alone (no box quantity column value)
    p401 = ix.parse_products(doc[400])
    rc = [r for r in p401 if r["model"] == "RC1748"]
    assert rc and rc[0]["size"].startswith("3-1/2"), rc[:1]
    # footnote text must not be swept into the size column
    assert not any("otherwise noted" in r["size"] for r in p401), \
        "page footnote leaked into the size column"

    # the Locks section rules only 'Description | Finish | List' - three column
    # labels. A 4-label minimum silently drops 30+ pages of lock pricing.
    p283 = ix.parse_products(doc[282])
    assert len(p283) > 15 and {r["model"] for r in p283} >= {"3947", "3949"}, p283[:2]

    items = ix.parse_item_numbers(doc[200])
    assert ("2930 ELECT STK US32D w/MDB & DBM LH", "158962") in items, items[:3]
    doc.close()

    # --- CSI classification ---------------------------------------------
    assert ix.classify("901P Coat Hook - Short single")[0] == "10"
    assert ix.classify("365M ADA Tactile Signage - MEN")[1] == "10 14 00"
    assert ix.classify("Commercial Hinges 1279 Steel Full Mortise")[0] == "08"
    assert ix.classify("185G Corner Guard")[1] == "10 26 00"
    assert ix.classify("Terms and conditions of sale")[0] is None

    # --- end to end through the MCP tools --------------------------------
    t0 = time.time()
    cat = json.loads(sv.open_catalog(book))
    elapsed = time.time() - t0
    cid = cat["catalog_id"]
    assert cat["price_rows"] > 5000, cat["price_rows"]
    assert cat["item_numbers"] > 20000, cat["item_numbers"]
    if cat["newly_indexed"]:
        assert elapsed < INDEX_BUDGET_S, f"indexing took {elapsed:.0f}s"
    divs = {d["division"].split(" - ")[0] for d in cat["divisions"]}
    assert "Division 08" in divs and "Division 10" in divs, divs

    d10 = json.loads(sv.list_division(cid, "10"))
    assert d10["models"] >= 20, d10["models"]
    models = {p["model"] for p in d10["products"]}
    assert {"901P", "365M", "185G"} <= models, sorted(models)[:20]

    # a division this book genuinely does not carry must come back empty,
    # with the covered divisions named - never a substitute product.
    d22 = json.loads(sv.list_division(cid, "22"))
    assert d22["products"] == [] and "covered_divisions" in d22

    lp = json.loads(sv.lookup_product(cid, "1251"))
    assert len(lp["price_rows"]) > 20, len(lp["price_rows"])
    assert any(r["finish"] == "US26D" and r["list_price"] == 61.70
               for r in lp["price_rows"])
    assert json.loads(sv.lookup_product(cid, "ZZ9999"))["found"] is False

    mm = json.loads(sv.match_materials(cid, [
        "coat hooks in restrooms",              # plural, catalog says "Coat Hook"
        "ADA restroom signage",
        "corner guards",
        "stainless steel toilet partition",     # generic words, real gap
        "metal lockers",                        # ditto - "metal" matches hinges
        "pile weatherstripping",                # real, but on unparsed pages
    ]))
    by = {r["requirement"]: r for r in mm["results"]}
    assert "901P" in [c["model"] for c in by["coat hooks in restrooms"]["candidates"]]
    assert [c["model"] for c in by["corner guards"]["candidates"]] == ["185G"], \
        "generic words are pulling hinges into a Division 10 match"
    assert by["ADA restroom signage"]["matched"]
    # a gap must be reported as a gap, never filled with a plausible neighbour
    assert {"stainless steel toilet partition", "metal lockers"} <= set(
        mm["unmatched"]), mm["unmatched"]
    # ... but "absent from the parsed rows" is not "absent from the catalog"
    thr = by["pile weatherstripping"]
    assert not thr["matched"] and thr["found_in_page_text"], thr

    vf = json.loads(sv.verify_facts(cid, ["901P Coat Hook", "1251", "61.70",
                                          "Hager 9000XL Toilet Partition"]))
    assert vf["unverified"] == ["Hager 9000XL Toilet Partition"], vf["unverified"]

    pg = json.loads(sv.get_page(cid, 60))
    assert pg["price_rows"] and pg["text_rows"]

    # --- a second vendor, and cross-catalog routing -----------------------
    if os.path.exists(ASI):
        asi = json.loads(sv.open_catalog(ASI))
        aid = asi["catalog_id"]
        # flat line-item layout: no column header band at all
        assert asi["price_rows"] > 1000, asi["price_rows"]
        assert asi["coverage"] == "structured", asi["coverage"]
        assert asi["multiplier_in_filename"] == ".375", asi
        assert asi["vendor_folder"] == "ASI"
        lp = json.loads(sv.lookup_product(aid, "10-9012"))
        assert lp["price_rows"][0]["list_price"] == 515.60, lp["price_rows"][:1]

        cats = json.loads(sv.list_catalogs())
        assert cats["catalogs"] >= 2

        # catalog_id="" searches the whole shelf and names the vendor
        d10 = json.loads(sv.list_division("", "10"))
        assert {"ASI", "HAGER"} <= set(d10["models_by_vendor"]), d10["models_by_vendor"]
        assert d10["models"] >= d10["showing"]     # counted in SQL, not from the page

        mm = json.loads(sv.match_materials("", [
            "baby changing station",                 # only ASI carries it
            "4-1/2 x 4-1/2 ball bearing hinge",      # only Hager does
            "36 inch stainless grab bar",            # long, specific, must not
        ]))                                          # match LESS than "grab bar"
        by = {r["requirement"]: r for r in mm["results"]}
        assert by["baby changing station"]["vendors_carrying"] == ["ASI"], by
        assert by["4-1/2 x 4-1/2 ball bearing hinge"]["vendors_carrying"] == ["HAGER"]
        grab = by["36 inch stainless grab bar"]
        assert grab["matched"] and all(
            c["csi_section"].startswith("10 28") for c in grab["candidates"]), grab
        # A parser upgrade must reach catalogs that were already indexed, and
        # must not leave the old rows behind still answering queries.
        before = ix.PARSER_VERSION
        try:
            ix.PARSER_VERSION += 1
            again = json.loads(sv.open_catalog(ASI))
            assert again["newly_indexed"], "parser bump did not force a re-index"
            rows = [c for c in json.loads(sv.list_catalogs())["indexed"]
                    if c["file"] == os.path.abspath(ASI)]
            assert len(rows) == 1, f"{len(rows)} stale copies left behind"
        finally:
            ix.PARSER_VERSION = before
            sv.open_catalog(ASI)

        print(f"    + {cats['catalogs']} catalogs on the shelf, "
              f"{len(cats['text_only_catalogs'])} text-only")

    print(f"OK  {cat['pages']}pp  {cat['price_rows']} price rows  "
          f"{cat['models']} models  {cat['item_numbers']} item numbers  "
          f"index {elapsed:.1f}s")
    for d in cat["divisions"]:
        print(f"    {d['division']:<28} {d['csi_section']:<45} "
              f"{d['models']:>4} models")


if __name__ == "__main__":
    main(*sys.argv[1:])
