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
from catint import workbook as wbk
from catint import overrides as ovr

# Resolved from this file, not hardcoded: the previous absolute path pointed at the
# superseded standalone checkout (see .agent/mcp/README.md), so the shelf was empty and
# nothing here could run from a normal clone.
_WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SHELF = os.environ.get("CBC_CATALOGS") or os.path.join(_WORKSPACE, "catalogs")
BOOK = f"{SHELF}/HAGER/Hager Price Book #18 - Complete - Effective 2-2-26.pdf"
# a second vendor, in the flat one-line-per-product layout the header parser
# cannot read - this is what `parse_line_items` exists for
ASI = f"{SHELF}/ASI/ASI-Price-List - 1-12-26 - .375 Multiplier.pdf"


# --------------------------------------------------------------------------- #
# Price recognition. These need no PDF, so pytest collects and runs them; the
# rest of this file is a script driven by main() against the real books.
# --------------------------------------------------------------------------- #

def test_price_pattern_reads_four_figure_prices():
    """`\\d{1,3}(?:,\\d{3})*` silently required a thousands separator, so any price
    over $999 printed without one was invisible. ASI's $1,537.20 baby changing
    station then parsed as $2.45 - the shipping cube from earlier on the line."""
    for value in ("45.00", "999.99", "1,234.56", "1000.00", "4053.20", "12345.67",
                  "$4053.20", "$ 45.00"):
        assert ix.PRICE_RX.match(value), f"{value!r} should be a price"
        assert ix.PRICE_ANY.search(value), f"{value!r} should be found in a line"


def test_price_pattern_rejects_non_prices():
    for value in ("12.5", "abc.00", "1,23.45", "48", "", "."):
        assert not ix.PRICE_RX.match(value), f"{value!r} is not a price"


def test_price_is_not_read_across_a_model_boundary():
    """Bobrick prints `B-686` immediately before `16.99`. A bare `\\d+\\.\\d{2}` starts
    mid-token and reads the pair as $68,616.99 for a $120.60 grab bar, which is worse
    than the missing row it was meant to fix."""
    assert ix.PRICE_ANY.findall("B-68616.99") == []
    assert ix.PRICE_ANY.findall("B-826.18") == []
    assert ix.PRICE_ANY.findall("10-0390-6-1A-41") == []
    # A real price on the same line is still found.
    assert "126.75" in ix.PRICE_ANY.findall("B-826 | Starter Kit | 0.38 | 5.90 126.75")
    assert ix.PRICE_ANY.findall("0.38    5.90 126.75")[-1] == "126.75"


def test_workbook_picks_the_orderable_model_not_the_family():
    """World Dryer prints `Model Family` (VERDEdri) beside `Model #` (Q-162A2). Taking
    the first header containing "model" gave every row in a family the same
    non-orderable code."""
    rows = [
        [None, None, None, "Effective 09/19/2022", None, "L3 Pricing Schedule"],
        ["Model Family", "Activation", "Cover", "Mounting", "Model #", "List Price"],
        ["VERDEdri", "Automatic", "Aluminum, Black", "Surface (ADA)", "Q-162A2", 1058],
    ]
    got = wbk.parse_sheet(rows, "L3 Pricing")
    assert len(got) == 1
    assert got[0]["model"] == "Q-162A2"
    assert got[0]["list_price"] == 1058
    assert got[0]["price_basis"] == "list"
    # The family is not lost - it becomes part of the description.
    assert "VERDEdri" in got[0]["description"]
    assert "Surface (ADA)" in got[0]["description"]


def test_workbook_keeps_each_price_column_apart():
    """Hamilton Parker prints five prices per model. Collapsing them to one number
    loses the only thing that says whether a multiplier still has to be applied."""
    rows = [
        ["MODEL NUMBER", "LIST", "DEALER", "COMMERCIAL", "MAP", "HAMILTON PARKER NET"],
        ["SOAP DISPENSERS", None, None, None, None, None],
        ["155", 13.5, 18.0, 27.0, 15.52, 11.7855],
    ]
    got = wbk.parse_sheet(rows, "Distributor Price List")
    by_basis = {r["price_basis"]: r["list_price"] for r in got}
    assert by_basis == {"list": 13.5, "dealer": 18.0, "commercial": 27.0,
                        "map": 15.52, "hamilton_parker_net": 11.7855}
    assert all(r["model"] == "155" for r in got)
    # A label row with no prices is a section heading, not a product.
    assert all(r["section"] == "SOAP DISPENSERS" for r in got)
    # And the net basis is flagged as already-a-cost.
    assert "hamilton_parker_net" in wbk.NET_BASES
    assert "list" not in wbk.NET_BASES


def test_workbook_tolerates_a_misspelled_header():
    """The Gamco sheets say "Distibutor NET". Header matching is on normalized
    substrings for exactly this reason - these are typed by hand."""
    rows = [["Model Number", "Distibutor NET"], ["100SX18", 29.45]]
    got = wbk.parse_sheet(rows, "2020 Price List")
    assert len(got) == 1
    assert got[0]["price_basis"] == "distributor_net"
    assert got[0]["list_price"] == 29.45


def test_workbook_ignores_a_sheet_with_no_price_table():
    """Shandas Cross Reference is a crossover table, not a price list."""
    rows = [["Model", "Bobrick Equivalent", "ASI Equivalent", "Bradley Crossover"],
            ["22", "264", None, None]]
    assert wbk.parse_sheet(rows, "Sheet1") == []
    assert wbk.find_header([["just", "a", "banner"]]) is None


def test_matrix_layout_prices_a_model_across_column_headings():
    """NGP prices one threshold across four door widths. No column is called "List", so
    the header parser never fired and the line-item parser rejected the rows for having
    no description - 88 pages yielded 15 rows between them."""
    rows = [
        'J U N E 8 , 2 0 2 6 P R I C E L I S T',
        'Type  |  Threshold  |  Materials  |  Single doors up to  |  Pair of doors up to',
        '36"  |  48"  |  72"  |  96"',
        '3  |  430E  |  1/2" x 10" Alum.  |  450.00  |  501.40  |  790.05  |  893.05',
    ]
    got = ix.parse_price_matrix(rows)
    assert len(got) == 4, "one row per priced column"
    assert {g["model"] for g in got} == {"430E"}, "the Type digit is not the model"
    assert [g["size"] for g in got] == ['36"', '48"', '72"', '96"']
    assert [g["list_price"] for g in got] == [450.00, 501.40, 790.05, 893.05]
    # The letter-spaced running head is not a product description.
    assert "P R I C E" not in got[0]["description"]
    assert got[0]["description"] == '3 1/2" x 10" Alum.'


def test_matrix_layout_reads_quantity_break_pricing():
    """NUDO prices an FRP panel across quantity breaks, with the block heading naming
    the product and the columns in the same row."""
    rows = [
        'LP-F9',
        'TEXTURED .090" FRP LINER PANEL  |  25 - 99  |  100-299  |  300-599  |  600+',
        '4X8  |  48.98  |  46.72  |  46.16  |  45.61',
    ]
    got = ix.parse_price_matrix(rows)
    assert len(got) == 4
    assert {g["model"] for g in got} == {"4X8"}
    assert [g["size"] for g in got] == ["25 - 99", "100-299", "300-599", "600+"]
    assert got[0]["list_price"] == 48.98
    # The product code above the block is kept, and the heading is not repeated.
    assert got[0]["description"] == 'LP-F9 TEXTURED .090" FRP LINER PANEL'


def test_matrix_parser_needs_at_least_two_prices():
    """One trailing number is a weight or a pack quantity, not a price matrix."""
    assert ix.parse_price_matrix(['A  |  B  |  C', '430E  |  Alum.  |  450.00']) == []


def test_matrix_fallback_is_gated_to_unparsed_books():
    """The matrix parser is credulous - it takes the first model-shaped cell as the
    model, which on Pemko p67 is the SIZE (`1/2 x 7`), and Rockwood's finish matrices
    merge prices into one cell so most are dropped. It must only run on a book the
    ordinary parsers could not read at all. Measured on this shelf, the books that need
    it sit at 0-3.4% of pages parsed and the next one up is at 6.8%."""
    assert ix.MATRIX_FALLBACK_RATIO == 0.05
    # NGP: 3 of 88 pages parsed -> runs. Rockwood Architectural: 6 of 88 -> does not.
    assert 3 < max(1, 88 * ix.MATRIX_FALLBACK_RATIO)
    assert not 6 < max(1, 88 * ix.MATRIX_FALLBACK_RATIO)
    # A single-page book that parsed nothing still qualifies.
    assert 0 < max(1, 1 * ix.MATRIX_FALLBACK_RATIO)


def test_crossover_sheet_is_read_as_equivalence_classes():
    """A crossover sheet prices nothing - reading it as a price list found no header
    and dropped 409 real equivalences on the floor. Stored as classes, not directed
    pairs: the Shandas sheet is 3,162 pairs saying the same 409 things."""
    rows = [
        ["Model", "Bobrick Equivalent", "ASI Equivalent", "Bradley Crossover"],
        ["23", 265, "0715", 5224],
        ["G-297FS", 297, "None", "None"],          # 'None' arrives as text, not null
        ["None", "132", "0337", "6583"],           # no source model, still a crossover
        ["orphan", "None", "None", "None"],        # one vendor states no equivalence
    ]
    classes = wbk.parse_crossover(rows, "SHANDAS")
    assert len(classes) == 3, "a single-vendor row is not an equivalence"

    first = dict((v, m) for v, m in classes[0])
    assert first == {"SHANDAS": "23", "BOBRICK": "265", "ASI": "0715",
                     "BRADLEY": "5224"}
    assert dict((v, m) for v, m in classes[1]) == {"SHANDAS": "G-297FS",
                                                   "BOBRICK": "297"}
    # A row with no source model still relates the three vendors that are present.
    assert "SHANDAS" not in dict((v, m) for v, m in classes[2])


def test_a_price_list_is_not_mistaken_for_a_crossover():
    rows = [["Model Number", "Distibutor NET"], ["100SX18", 29.45]]
    assert wbk.parse_crossover(rows, "GAMCO") == []


def _override_sandbox(tmp_path, monkeypatch):
    """Point the override file at a throwaway workspace, never the real memory/."""
    (tmp_path / "memory").mkdir()
    monkeypatch.setenv("CBC_WORKSPACE_ROOT", str(tmp_path))
    ovr._CACHE["stamp"] = None
    return tmp_path / "memory" / ovr.FILENAME


def test_override_round_trips_and_wins_by_recency(tmp_path, monkeypatch):
    _override_sandbox(tmp_path, monkeypatch)
    assert ovr.for_model("HAGER", "BB1279") == []

    ovr.record({"vendor": "HAGER", "model": "BB1279", "price": 30.0,
                "price_basis": "net", "source": "quote 1"})
    ovr.record({"vendor": "HAGER", "model": "BB1279", "price": 24.15,
                "price_basis": "net", "source": "quote 2 supersedes"})

    hits = ovr.for_model("HAGER", "BB1279")
    assert len(hits) == 2, "appended, not rewritten - the history is the audit trail"
    assert hits[0]["price"] == 24.15, "the newest override must rank first"
    assert hits[0]["source"] == "quote 2 supersedes"


def test_override_for_one_finish_still_answers_a_model_lookup(tmp_path, monkeypatch):
    """lookup_product asks "what does this model cost" and returns every variant. An
    override recorded against US26D belongs in that answer; filtering it out on a blank
    finish hid it completely."""
    _override_sandbox(tmp_path, monkeypatch)
    ovr.record({"vendor": "HAGER", "model": "BB1279", "finish": "US26D",
                "price": 24.15, "price_basis": "net", "source": "quote"})

    assert len(ovr.for_model("HAGER", "BB1279")) == 1
    # ...but a variant-specific question still respects the finish.
    row = ovr.load()[0]
    assert ovr.matches(row, "HAGER", "BB1279", finish="US26D")
    assert not ovr.matches(row, "HAGER", "BB1279", finish="US32D")
    assert not ovr.matches(row, "ROCKWOOD", "BB1279", finish="US26D")


def test_override_requires_its_audit_trail(tmp_path, monkeypatch):
    """An unattributed price is the thing this file exists to replace."""
    _override_sandbox(tmp_path, monkeypatch)
    for missing in ("vendor", "model", "price_basis", "source"):
        entry = {"vendor": "V", "model": "M", "price": 1.0,
                 "price_basis": "net", "source": "s"}
        entry[missing] = ""
        try:
            ovr.record(entry)
            raise AssertionError(f"recorded an override with no {missing}")
        except ValueError as exc:
            assert missing in str(exc)

    for bad_price in ("abc", None, -5):
        entry = {"vendor": "V", "model": "M", "price": bad_price,
                 "price_basis": "net", "source": "s"}
        try:
            ovr.record(entry)
            raise AssertionError(f"recorded a price of {bad_price!r}")
        except ValueError:
            pass


def test_override_file_survives_a_hand_edit(tmp_path, monkeypatch):
    """It is a versioned text file, so someone will edit it by hand. One bad line must
    not take out every lookup."""
    path = _override_sandbox(tmp_path, monkeypatch)
    ovr.record({"vendor": "HAGER", "model": "BB1279", "price": 24.15,
                "price_basis": "net", "source": "quote"})
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("{ this is not json\n")
        handle.write("// a comment\n")
        handle.write("\n")
    ovr._CACHE["stamp"] = None
    assert len(ovr.load(force=True)) == 1


def test_price_cell_holding_two_numbers_is_not_a_price():
    """`813061  530.10` is an item number beside a price. It was validated with the
    spaces stripped and then converted with them still in, which raised ValueError -
    and because index_catalog catches per page, took the whole page down with it."""
    assert not ix.PRICE_RX.match("813061 530.10")
    assert not ix.PRICE_RX.match("216.00 B-918116R")


def test_model_tokens_cover_hager_adder_and_long_prefix_codes():
    """MODEL_RX used to require 2+ digits right after ≤4 letters, so ETW-4, IHTAB750
    and starred codes never started a description block — every price below prose
    inherited model=NULL and led the shelf table."""
    assert ix._normalize_model_token("ETW-4") == "ETW-4"
    assert ix._normalize_model_token("ETM-12") == "ETM-12"
    assert ix._normalize_model_token("IHTAB750") == "IHTAB750"
    assert ix._normalize_model_token("ECBB1102*") == "ECBB1102"
    assert ix._normalize_model_token("BB1279") == "BB1279"
    assert ix._normalize_model_token("1251") == "1251"
    assert ix._normalize_model_token("Miniature") is None
    assert ix._normalize_model_token("4") is None


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

    # p12 electric adder pages: dual List columns + ETW/ETM codes. Null-model
    # narrative rows must not be emitted; codes must bind to prices.
    p12 = ix.parse_products(doc[11])
    assert p12, "no price rows parsed from p12"
    assert all(r["model"] for r in p12), p12[:3]
    models12 = {r["model"] for r in p12}
    assert any(m.startswith(("ETW", "ETM")) for m in models12), models12
    finishes12 = {r["finish"] for r in p12}
    assert "Steel/Brass" in finishes12 or "Stainless Steel" in finishes12, finishes12

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
