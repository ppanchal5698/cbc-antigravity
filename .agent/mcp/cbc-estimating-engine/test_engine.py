"""Unit tests for CBC estimating engine."""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from cbc_engine import engine, okf

# Scripts and outputs the sandbox tests write. Cleaned up afterwards so a test run does not
# leave litter in sandbox/scripts, which is a versioned directory.
_SANDBOX_ARTIFACTS = (
    "scripts/unit_test_script.py",
    "scripts/escape_check.py",
    "scripts/pathlib_escape_check.py",
    "scripts/pathlib_ok_check.py",
    "scripts/touch_one.py",
    "workspace/test_output.txt",
    "outputs/touched_one.txt",
    "outputs/pathlib_ok.txt",
)


def tearDownModule():
    runner = engine._find_sandbox_runner()
    if runner is None:
        return
    for rel in _SANDBOX_ARTIFACTS:
        (runner.parent / rel).unlink(missing_ok=True)


class TestCBCEstimatingEngine(unittest.TestCase):

    def test_calculate_quote_line_standard(self):
        res = engine.calculate_quote_line(
            cost=100.0,
            margin=0.27,
            quantity=2,
            cost_source="catalog_list_x_multiplier",
            cost_source_detail="Hager PB#18 p42, 0.29 mult, eff 2026-03-02",
        )
        self.assertEqual(res["unit_cost"], 100.0)
        self.assertEqual(res["margin_rate"], 0.27)
        self.assertEqual(res["quantity"], 2)
        self.assertEqual(res["sale_ea"], 136.99)
        self.assertEqual(res["ext_sale"], 273.98)
        self.assertEqual(res["ext_cost"], 200.0)
        self.assertEqual(res["ext_margin_dollars"], 73.98)
        self.assertEqual(res["cost_source"], "catalog_list_x_multiplier")
        self.assertIn("Hager PB#18", res["cost_source_detail"])

    def test_calculate_quote_line_accessory_margin(self):
        res = engine.calculate_quote_line(cost=50.0, margin=0.56, quantity=5)
        self.assertEqual(res["sale_ea"], 113.64)
        self.assertEqual(res["ext_sale"], 568.20)

    def test_vendor_multiplier_lookup(self):
        hager = engine.lookup_vendor_multiplier("Hager Companies")
        self.assertEqual(hager["multiplier"], 0.29)
        self.assertEqual(hager["basis"], "list")

        asi = engine.lookup_vendor_multiplier("ASI")
        self.assertEqual(asi["multiplier"], 0.375)

        bobrick = engine.lookup_vendor_multiplier("Bobrick")
        self.assertEqual(bobrick["multiplier"], 1.0)
        self.assertEqual(bobrick["basis"], "net")

        banner = engine.lookup_vendor_multiplier("Banner Solutions")
        self.assertIsNone(banner["multiplier"])
        self.assertEqual(banner["sourcing_type"], "wholesaler")
        self.assertEqual(banner["action_required"], "MANUAL_PRICE_ENTRY")

    def test_margin_bands(self):
        comm = engine.get_margin_band("commodity")
        self.assertEqual(comm["margin"], 0.27)
        self.assertEqual(comm["divisor"], 0.73)

        acc = engine.get_margin_band("washroom accessories")
        self.assertEqual(acc["margin"], 0.56)

        wendys = engine.get_margin_band("commodity", customer="wendys")
        self.assertEqual(wendys["margin"], 0.22)

    def test_finish_conversion(self):
        conv1 = engine.convert_finish_code("US26D")
        self.assertEqual(conv1["bhma_code"], "626")
        self.assertFalse(conv1["is_premium"])

        conv2 = engine.convert_finish_code("630")
        self.assertEqual(conv2["us_code"], "US32D")
        self.assertTrue(conv2["is_premium"])

        conv3 = engine.convert_finish_code("US10B")
        self.assertEqual(conv3["bhma_code"], "613")
        self.assertTrue(conv3["is_premium"])

    def test_frame_throat_derivation(self):
        masonry = engine.calculate_frame_throat("Concrete Masonry Unit")
        self.assertEqual(masonry["recommended_throat"], "5-3/4\"")

        stud6 = engine.calculate_frame_throat("6\" Stud partition")
        self.assertEqual(stud6["recommended_throat"], "8-1/4\"")

        mcd = engine.calculate_frame_throat("3-5/8 stud with 1/2 drywall")
        self.assertEqual(mcd["recommended_throat"], "5-5/8\"")

        std = engine.calculate_frame_throat("Standard drywall partition")
        self.assertEqual(std["recommended_throat"], "5-7/8\"")

    def test_frame_throat_matches_its_own_standards_table(self):
        """Every wall string STANDARD_FRAME_THROATS prints must derive the throat that
        table pairs it with. `6" metal stud + 5/8" drywall` used to return 5-7/8"
        because the matcher tested for the literal substring `6" stud`."""
        for entry in engine.STANDARD_FRAME_THROATS:
            got = engine.calculate_frame_throat(entry["wall"])
            self.assertEqual(got["recommended_throat"], entry["throat"],
                             f'{entry["wall"]!r} derived the wrong throat')

    def test_frame_throat_reads_stud_width_however_it_is_written(self):
        for wall in ('6" metal stud + 5/8" drywall', "6 metal stud with 5/8 gyp",
                     '6" stud partition', "6 inch steel stud", "2x6 metal studs"):
            self.assertEqual(
                engine.calculate_frame_throat(wall)["recommended_throat"], '8-1/4"', wall)

        for wall in ('3-5/8" metal stud + 5/8" Type X drywall', "3-5/8 stud"):
            self.assertEqual(
                engine.calculate_frame_throat(wall)["recommended_throat"], '5-7/8"', wall)

    def test_parse_door_size(self):
        d3070 = engine.parse_door_size("3070")
        self.assertTrue(d3070["parsed"])
        self.assertEqual(d3070["width_total_in"], 36)
        self.assertEqual(d3070["height_total_in"], 84)
        self.assertEqual(d3070["display"], "3'-0\" x 7'-0\"")

        d3670 = engine.parse_door_size("3670")
        self.assertTrue(d3670["parsed"])
        self.assertEqual(d3670["width_total_in"], 42)

    def test_frp_takeoff(self):
        frp = engine.calculate_frp_takeoff(perimeter_lf=40.0, inside_corners=4, wall_height_ft=9.0)
        self.assertEqual(frp["sheet_count"], 11)
        self.assertEqual(frp["trims"]["inside_corners_10ft"], 4)
        self.assertGreater(frp["trims"]["adhesive_4gal_pails"], 0)

    def test_hardware_set_expansion(self):
        hw = engine.expand_hardware_set(
            set_callout="HW Set 01 - Interior Office",
            door_size="3070",
            handing="LH",
            fire_rating="45 min",
            finish="626",
            keyway="Schlage C",
        )
        self.assertGreaterEqual(len(hw["components"]), 5)
        components = [item["component"] for item in hw["components"]]
        self.assertTrue(any("Hinges" in c for c in components))
        self.assertTrue(any("Lockset" in c for c in components))
        self.assertTrue(any("Smoke Gasket" in c for c in components))
        self.assertTrue(len(hw["fire_rating_flags"]) > 0)
        self.assertEqual(hw["keyway"], "Schlage C")

    def test_lite_louver_price_stub(self):
        res = engine.calculate_lite_louver_price(
            glazing_type="Wire Glass",
            lite_size="10x10",
            door_size="3070",
            vendor="NGP",
        )
        self.assertEqual(res["preferred_vendor"], "NGP")
        self.assertIn("lookup_instructions", res)

    def test_format_cbc_proposal(self):
        audit = {"cost_source": "catalog_list_x_multiplier",
                 "cost_source_detail": "Hager PB#18 p42, 0.29 mult",
                 "quantity_source": "schedule:A2.2 row 101"}
        doors = [{"ext_cost": 1000.0, "ext_sale": 1369.86, **audit}]
        accessories = [{"ext_cost": 500.0, "ext_sale": 1136.36, **audit}]
        proposal = engine.format_cbc_proposal(
            project_name="Baldwin PA Commercial Center",
            door_lines=doors,
            accessories_lines=accessories,
            state="OH",
        )
        self.assertEqual(proposal["state"], "OH")
        self.assertEqual(proposal["doors_subtotal"], 1369.86)
        self.assertEqual(proposal["accessories_subtotal"], 1136.36)
        self.assertAlmostEqual(proposal["base_bid_subtotal"], 2506.22)
        self.assertGreater(proposal["sales_tax_amount"], 0)
        self.assertTrue(proposal["audit_passed"])
        self.assertIn("DRAFT", proposal["status"])

    def test_route_model_for_task_tiers(self):
        """Effort tiers, not model names — model choice is the user's in Antigravity."""
        t1 = engine.route_model_for_task("math_calculation")
        self.assertEqual(t1["recommended_tier"], "routine")

        t3 = engine.route_model_for_task("title_block_read", vision_need="identity")
        self.assertEqual(t3["recommended_tier"], "visual")

        t2 = engine.route_model_for_task("schedule_takeoff", has_conflicts=True)
        self.assertEqual(t2["recommended_tier"], "deliberate")

        t2_fire = engine.route_model_for_task("hardware_expansion", is_fire_rated_or_complex=True)
        self.assertEqual(t2_fire["recommended_tier"], "deliberate")

        # No model ID anywhere in the payload — that was the thing that dated this tool.
        self.assertNotIn("models", t1)

    def test_execute_sandbox_script(self):
        sample_code = """
import os
from pathlib import Path
from cbc_engine import engine

# Verify sandbox isolation
cwd = os.getcwd()
with open("test_output.txt", "w") as f:
    f.write("sandbox run ok")

line = engine.calculate_quote_line(100.0, 0.27, 1, "vendor_rfq", "detail")
print(f"CALCULATED_SALE:{line['sale_ea']}")
"""
        res = engine.execute_sandbox_script(
            script_name="unit_test_script.py",
            code_content=sample_code,
            timeout_seconds=10,
        )
        self.assertTrue(res["success"])
        self.assertEqual(res["exit_code"], 0)
        self.assertIn("CALCULATED_SALE:136.99", res["stdout"])
        self.assertIn("workspace\\test_output.txt", [f.replace("/", "\\") for f in res["created_files"]])


class TestGuardrails(unittest.TestCase):
    """Regressions for the defects found in the 2026-08 audit.

    Each of these failed before the fix. They exercise shipped code — nothing here
    redefines the thing it is testing.
    """

    def test_ngp_alias_resolves_to_national_guard(self):
        """expand_hardware_set emits lookup_product('NGP', ...) for every threshold,
        sweep and smoke gasket. 'NGP' is not a substring of 'NATIONAL GUARD PRODUCTS',
        so those lines used to fall through to VENDOR_RFQ_REQUIRED and silently lose
        the 0.45 multiplier."""
        for written in ("NGP", "ngp", "National Guard", "National Guard Products",
                        "NGP 412S"):
            res = engine.lookup_vendor_multiplier(written)
            self.assertEqual(res["matched_vendor"], "NATIONAL GUARD PRODUCTS", written)
            self.assertEqual(res["multiplier"], 0.45, written)

        self.assertEqual(
            engine.lookup_vendor_multiplier("Markar")["matched_vendor"], "PEMKO")

    def test_vendor_lookup_rejects_stray_short_strings(self):
        """The old two-way substring test let a one-letter vendor match a real tier."""
        for junk in ("S", "A", "Acme Fasteners", ""):
            res = engine.lookup_vendor_multiplier(junk)
            self.assertIsNone(res["multiplier"], junk)
            self.assertEqual(res["action_required"], "VENDOR_RFQ_REQUIRED", junk)

    def test_margin_category_precedence(self):
        """'custom laminate door' contains 'door', and the old keyword order tested
        'door' first — so a custom fabrication was priced as a 27% commodity."""
        self.assertEqual(
            engine.get_margin_band("custom laminate door")["category_key"], "custom_built")
        self.assertEqual(
            engine.get_margin_band("laminate door")["category_key"], "specialty")
        self.assertEqual(
            engine.get_margin_band("hollow metal door")["category_key"], "commodity")
        self.assertEqual(
            engine.get_margin_band("toilet partition")["category_key"],
            "restroom_partitions")
        self.assertEqual(
            engine.get_margin_band("hand dryer")["category_key"], "accessories")

    def test_margin_override_recorded(self):
        """Requirements 6.1 / FR-5: margin is overridable by sourcing, and the
        deviation has to be visible on the line."""
        band = engine.get_margin_band(
            "door hardware", override_margin=0.18,
            override_reason="bought through Banner at distributor net")
        self.assertEqual(band["margin"], 0.18)
        self.assertEqual(band["margin_source"], "estimator_override")
        self.assertEqual(band["standard_margin"], 0.27)
        self.assertAlmostEqual(band["deviation_from_standard"], -0.09, places=4)

        wendys = engine.get_margin_band("door", customer="Wendy's")
        self.assertEqual(wendys["margin"], 0.22)
        self.assertTrue(wendys["margin_source"].startswith("customer_programme"))

        with self.assertRaises(ValueError):
            engine.get_margin_band("door", override_margin=1.0)

    def test_quote_line_rejects_unknown_cost_source(self):
        with self.assertRaises(ValueError):
            engine.calculate_quote_line(100.0, 0.27, 1, cost_source="vibes")

    def test_cost_freshness_bands(self):
        """Requirements 6.2: under a year good, 3-4 years must be discarded."""
        as_of = "2026-08-07"
        self.assertEqual(
            engine.check_cost_freshness("2026-05-01", as_of)["status"], "fresh")
        self.assertEqual(
            engine.check_cost_freshness("2025-01-01", as_of)["status"], "review")
        self.assertFalse(
            engine.check_cost_freshness("2024-01-01", as_of)["usable"])
        self.assertEqual(
            engine.check_cost_freshness("2020-01-01", as_of)["status"], "discard")
        self.assertFalse(engine.check_cost_freshness("not a date")["usable"])

    def test_frp_takeoff_flags_provisional_constants(self):
        """CBC Open Item 5 is still Partial — the conversion constants are assumptions,
        and every FRP line has to say so."""
        res = engine.calculate_frp_takeoff(perimeter_lf=84.0, wall_height_ft=9.0)
        self.assertTrue(res["provisional"])
        self.assertIn("Open Item 5", res["constants_used"]["source"])
        self.assertIn("REVIEW", res["action_required"])
        self.assertEqual(res["sheet_count"], 24)          # ceil(84/4 * 1.10)

    def test_hardware_set_is_labelled_a_reference_not_a_spec(self):
        """Requirements 7.2/7.7: there is no single standard hardware list and the
        spec's schedule is the authority. The engine set is a fallback."""
        res = engine.expand_hardware_set("HW-1", door_size="3070")
        self.assertEqual(res["source"], "cbc_reference_set")
        self.assertTrue(res["requires_estimator_confirmation"])
        self.assertIn("NOT A SPECIFICATION", res["action_required"])
        for item in res["components"]:
            self.assertNotIn("price", item)
            self.assertNotIn("list_price", item)

    def test_proposal_blocks_lines_with_no_audit_trail(self):
        """The 'every line carries an audit citation' rule had no enforcement point
        anywhere in the code — a proposal would total unsourced lines happily."""
        unsourced = [{"tag": "101", "ext_sale": 100.0, "ext_cost": 73.0}]
        res = engine.format_cbc_proposal("Test", unsourced, [], state="OH")
        self.assertFalse(res["audit_passed"])
        self.assertIn("NOT READY", res["status"])
        self.assertTrue(any(f["problem"] == "no cost_source"
                            for f in res["audit_failures"]))

        sourced = [{
            "tag": "101", "ext_sale": 100.0, "ext_cost": 73.0,
            "cost_source": "catalog_list_x_multiplier",
            "cost_source_detail": "Hager PB#18 p42, 0.29 mult",
            "quantity_source": "schedule:A2.2 row 101",
        }]
        ok = engine.format_cbc_proposal("Test", sourced, [], state="OH")
        self.assertTrue(ok["audit_passed"])
        self.assertIn("DRAFT", ok["status"])
        self.assertEqual(ok["sales_tax_amount"], 8.0)
        self.assertIsNone(ok["freight"]["amount"])          # FR-7 / Open Item 1

    def test_alternate_is_reported_as_a_delta_against_the_base_bid(self):
        """`net_delta_vs_base` carried the alternate's own total, so an alternate read
        as its full value rather than what it changes."""
        base = [{"ext_sale": 1000.0, "ext_cost": 730.0,
                 "cost_source": "p21_last_po", "cost_source_detail": "PO 88213"}]
        res = engine.format_cbc_proposal(
            "t", base, [], state="PA",
            alternates_lines=[{"name": "Alt 1 - stainless", "lines": [{"ext_sale": 1250.0}]}])
        alt = res["alternates"][0]
        self.assertEqual(alt["ext_sale"], 1250.0)
        self.assertEqual(alt["net_delta_vs_base"], 250.0)

    def test_proposal_tax_by_state(self):
        line = [{"ext_sale": 1000.0, "ext_cost": 730.0,
                 "cost_source": "p21_last_po", "cost_source_detail": "PO 88213"}]
        self.assertEqual(
            engine.format_cbc_proposal("t", line, [], state="KY")["sales_tax_amount"], 65.0)
        self.assertEqual(
            engine.format_cbc_proposal("t", line, [], state="PA")["sales_tax_amount"], 0.0)

    def test_sandbox_refuses_writes_outside_sandbox(self):
        """runner.py's README claimed scripts 'cannot modify root files'. Only cwd was
        set, so any absolute path wrote straight into memory/ or catalogs/."""
        escape = (
            "import os\n"
            "target = os.path.join(os.environ['CBC_WORKSPACE_ROOT'], 'memory',"
            " 'SANDBOX_ESCAPE_CANARY.txt')\n"
            "try:\n"
            "    open(target, 'w').write('escaped')\n"
            "    print('ESCAPED')\n"
            "except PermissionError as exc:\n"
            "    print('BLOCKED')\n"
        )
        res = engine.execute_sandbox_script(
            script_name="escape_check.py", code_content=escape, timeout_seconds=20)
        self.assertIn("BLOCKED", res["stdout"], res.get("stderr", ""))
        self.assertNotIn("ESCAPED", res["stdout"])

        canary = Path(engine.__file__).resolve()
        for parent in canary.parents:
            probe = parent / "memory" / "SANDBOX_ESCAPE_CANARY.txt"
            if (parent / "memory").is_dir():
                self.assertFalse(probe.exists(), "sandbox guard did not hold")
                break

    def test_sandbox_refuses_a_script_name_that_leaves_scripts_dir(self):
        """The write happens in the SERVER process, which has no write guard - that one is
        installed in the child. So an unchecked script_name wrote anywhere and was then
        executed: '../../.agent/rules/x' landed in the always-on rules directory."""
        runner = engine._find_sandbox_runner()
        if runner is None:
            self.skipTest("sandbox/runner.py not found")
        sandbox = runner.parent

        for name in ("../../.agent/rules/PWNED_CANARY",
                     "../PWNED_CANARY",
                     "subdir/PWNED_CANARY",
                     str(Path(sandbox.anchor) / "PWNED_CANARY")):
            with self.subTest(script_name=name):
                res = engine.execute_sandbox_script(
                    script_name=name, code_content="print('should never run')",
                    timeout_seconds=20)
                self.assertFalse(res["success"], res)
                self.assertNotIn("should never run", res.get("stdout", ""))

        # Nothing was written anywhere the traversal pointed.
        for probe in (sandbox.parent / ".agent" / "rules" / "PWNED_CANARY.py",
                      sandbox.parent / "PWNED_CANARY.py",
                      Path(sandbox.anchor) / "PWNED_CANARY.py"):
            self.assertFalse(probe.exists(), f"sandbox escape wrote {probe}")

    def test_sandbox_still_accepts_a_plain_script_name(self):
        """The guard must not break the ordinary case."""
        res = engine.execute_sandbox_script(
            script_name="unit_test_script", code_content="print('plain name ok')",
            timeout_seconds=20)
        self.assertTrue(res["success"], res)
        self.assertIn("plain name ok", res["stdout"])

    def test_sandbox_guard_covers_pathlib(self):
        """The guard patched builtins.open only. pathlib goes through io.open, so
        Path.write_text - the way most code writes a file - walked straight past it."""
        escape = (
            "import os\n"
            "from pathlib import Path\n"
            "target = Path(os.environ['CBC_WORKSPACE_ROOT']) / 'memory' /"
            " 'SANDBOX_PATHLIB_CANARY.txt'\n"
            "for label, write in (\n"
            "    ('write_text', lambda: target.write_text('escaped')),\n"
            "    ('write_bytes', lambda: target.write_bytes(b'escaped')),\n"
            "    ('path_open', lambda: target.open('w').write('escaped')),\n"
            "):\n"
            "    try:\n"
            "        write()\n"
            "        print(f'ESCAPED via {label}')\n"
            "    except PermissionError:\n"
            "        print(f'BLOCKED {label}')\n"
        )
        res = engine.execute_sandbox_script(
            script_name="pathlib_escape_check.py", code_content=escape, timeout_seconds=20)
        self.assertNotIn("ESCAPED", res["stdout"], res.get("stderr", ""))
        for label in ("write_text", "write_bytes", "path_open"):
            self.assertIn(f"BLOCKED {label}", res["stdout"])

        canary = Path(engine.__file__).resolve()
        for parent in canary.parents:
            if (parent / "memory").is_dir():
                self.assertFalse((parent / "memory" / "SANDBOX_PATHLIB_CANARY.txt").exists())
                break

    def test_sandbox_still_writes_inside_the_sandbox(self):
        """Guarding io.open must not break legitimate pathlib writes to sandbox/."""
        script = (
            "import os\n"
            "from pathlib import Path\n"
            "p = Path(os.environ['CBC_OUTPUTS_ROOT']) / 'pathlib_ok.txt'\n"
            "p.write_text('fine')\n"
            "print('WROTE', p.read_text())\n"
        )
        res = engine.execute_sandbox_script(
            script_name="pathlib_ok_check.py", code_content=script, timeout_seconds=20)
        self.assertTrue(res["success"], res.get("stderr"))
        self.assertIn("WROTE fine", res["stdout"])

    def test_sandbox_reports_only_the_files_it_touched(self):
        """created_files compared st_mtime against perf_counter, so every run reported
        every sandbox file as new."""
        script = (
            "import os\n"
            "open(os.path.join(os.environ['CBC_OUTPUTS_ROOT'], 'touched_one.txt'),"
            " 'w').write('x')\n"
        )
        res = engine.execute_sandbox_script(
            script_name="touch_one.py", code_content=script, timeout_seconds=20)
        self.assertTrue(res["success"], res.get("stderr"))
        self.assertEqual(
            [f for f in res["created_files"] if "touched_one" in f],
            [f for f in res["created_files"]],
            f"expected only touched_one.txt, got {res['created_files']}")


class TestOKFKnowledgeGraph(unittest.TestCase):
    """OKF regressions. Every test runs against a temp copy of the real graph, so the
    workspace graph is never mutated by the suite."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        src = okf._default_graph_path()
        self.path = Path(self.tmp) / "graph.json"
        shutil.copy(src, self.path)
        self.kg = okf.OKFKnowledgeGraph(self.path)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_graph_holds_no_prices(self):
        """The graph's whole purpose fails if a price in it can reach a quote line
        without ever passing verify_facts."""
        self.assertEqual(self.kg.validation_errors, [])
        for node in self.kg.get_nodes_by_class("CatalogProduct"):
            for field in okf.FORBIDDEN_PRODUCT_FIELDS:
                self.assertNotIn(field, node, f"{node['id']} carries {field}")

    def test_brand_id_normalization_is_symmetric(self):
        """learn_from_quote wrote brand:wendy's while get_brand_intelligence read
        brand:wendys, so reinforcement silently went nowhere."""
        for spelling in ("Wendy's", "Wendy’s", "wendys", "WENDYS", "  Wendys  "):
            self.assertEqual(
                self.kg.get_brand_intelligence(spelling)["brand_id"], "brand:wendys",
                spelling)

        before = len(self.kg.outgoing_edges.get("brand:wendys", []))
        res = self.kg.learn_from_quote(
            {"door_lines": [{"hw_set": "HW-1"}]}, brand="Wendy's")
        self.assertEqual(res["brand_id"], "brand:wendys")
        self.assertTrue(any("reinforced" in r or "created" in r
                            for r in res["reinforcements"]), res)
        self.assertGreaterEqual(len(self.kg.outgoing_edges["brand:wendys"]), before)

    def test_unconfirmed_brand_margins_fall_back_not_fabricate(self):
        """NR-9: only Wendy's margins are CBC-confirmed. McDonald's and Cava must not
        return an invented rate."""
        for brand in ("McDonald's", "Cava"):
            intel = self.kg.get_brand_intelligence(brand)
            self.assertEqual(intel["margin_status"], "PENDING_CBC_DATA", brand)
            self.assertEqual(intel["commodity_margin"], 0.27, brand)
            self.assertIn("estimator", intel["margin_note"].lower())

        wendys = self.kg.get_brand_intelligence("Wendy's")
        self.assertEqual(wendys["margin_status"], "confirmed")
        self.assertEqual(wendys["commodity_margin"], 0.22)

    def test_correction_creates_the_edges_the_rules_promise(self):
        """The rules said learn_from_correction 'links SUPERSEDES and SUBSTITUTED_BY'.
        It created no edges at all."""
        res = self.kg.learn_from_correction({
            "specified_callout": "Hager 3500 Storeroom",
            "copilot_initial_match": "3510 WTN Passage",
            "estimator_override": "3570 WTN Storeroom",
            "reason": "Grade 1 required on service entrance",
            "division": "08",
        })
        self.assertEqual(res["status"], "learned_correction")
        pattern = self.kg.get_node(res["pattern_id"])
        self.assertIsNotNone(pattern)
        self.assertEqual(pattern["class"], "EstimatorCorrectionPattern")

        edge_types = {e["type"] for edges in self.kg.outgoing_edges.values() for e in edges}
        self.assertIn("SUPERSEDES", edge_types)
        self.assertIn("SUBSTITUTED_BY", edge_types)

    def test_correction_confidence_is_earned_not_assumed(self):
        """One override is evidence, not law — and re-ingesting must not duplicate."""
        record = {
            "specified_callout": "Hager 3500 Storeroom",
            "copilot_initial_match": "3510 WTN Passage",
            "estimator_override": "3570 WTN Storeroom",
            "reason": "Grade 1 required",
        }
        first = self.kg.learn_from_correction(record)
        self.assertLess(first["confidence_weight"], 1.0)
        self.assertEqual(first["times_applied"], 1)

        nodes_after_first = len(self.kg.nodes)
        second = self.kg.learn_from_correction(record)
        self.assertEqual(second["times_applied"], 2)
        self.assertGreater(second["confidence_weight"], first["confidence_weight"])
        self.assertEqual(len(self.kg.nodes), nodes_after_first,
                         "re-ingesting a correction duplicated nodes")
        self.assertEqual(
            len(self.kg.get_nodes_by_class("EstimatorCorrectionPattern")),
            len({n["id"] for n in self.kg.get_nodes_by_class("EstimatorCorrectionPattern")}))

    def test_finish_only_correction_is_not_a_substitution(self):
        """It used to mint a VendorEquivalence for every correction, teaching the graph
        substitutions nobody approved."""
        res = self.kg.learn_from_correction({
            "specified_callout": "Hager 3510 WTN",
            "copilot_initial_match": "3510 WTN Passage",
            "estimator_override": "3510 WTN Passage",
            "reason": "finish corrected to 630",
        })
        self.assertIsNone(res["equiv_id"])

    def test_changed_finish_or_quantity_is_still_not_a_substitution(self):
        """The guard only compared the two strings, so any correction that changed a
        value at all minted an `estimator_approved` VendorEquivalence. A US26D -> US32D
        finish fix taught the graph that 'US32D' was an approved equal for the hinge."""
        for initial, override, why in (
            ("US26D", "US32D", "finish"),
            ("626", "630", "bhma finish"),
            ("3", "4", "quantity"),
        ):
            res = self.kg.learn_from_correction({
                "specified_callout": "Hager BB1279 4.5x4.5 hinge",
                "copilot_initial_match": initial,
                "estimator_override": override,
                "reason": f"{why} corrected",
            })
            self.assertIsNone(res["equiv_id"], f"{why}: {initial} -> {override}")
            self.assertIsNone(
                self.kg.lookup_vendor_equivalence("Hager BB1279 4.5x4.5 hinge"), why)

    def test_a_real_model_swap_is_still_learned(self):
        """The guard must not be so tight that genuine substitutions stop landing, and
        what was just learned must be what the lookup returns."""
        res = self.kg.learn_from_correction({
            "specified_callout": "Von Duprin 9947EO exit device",
            "copilot_initial_match": "9947EO",
            "estimator_override": "Hager 4500 Series Rim Exit",
            "reason": "direct equal approved by GC",
        })
        self.assertIsNotNone(res["equiv_id"])
        equiv = self.kg.get_node(res["equiv_id"])
        self.assertEqual(equiv["class"], "VendorEquivalence")
        self.assertEqual(equiv["proposed_model"], "Hager 4500 Series Rim Exit")
        self.assertTrue(equiv["estimator_approved"])

        found = self.kg.lookup_vendor_equivalence("Von Duprin 9947EO exit device")
        self.assertEqual(found["proposed_model"], "Hager 4500 Series Rim Exit")

    def test_equivalence_lookup_returns_the_best_match_not_the_first(self):
        """It returned the first node that matched in insertion order, so a loose
        substring hit on a seeded node beat an exact match stored later - and a freshly
        learned estimator override lost to whatever was already in the file."""
        # Deliberately inserted first, and deliberately the weaker match.
        self.kg._index_node({
            "id": "equiv:loose", "class": "VendorEquivalence",
            "specified_model": "4040XP", "proposed_vendor": "Loose",
            "proposed_model": "WRONG - loose substring match",
            "estimator_approved": False, "confidence": 0.5,
        })
        self.kg._index_node({
            "id": "equiv:exact", "class": "VendorEquivalence",
            "specified_model": "lcn 4040xp closer", "proposed_vendor": "Exact",
            "proposed_model": "RIGHT - exact match",
            "estimator_approved": True, "confidence": 0.9,
        })

        found = self.kg.lookup_vendor_equivalence("LCN 4040XP closer")
        self.assertEqual(found["proposed_model"], "RIGHT - exact match")

        # With no exact match left, the estimator-approved node outranks the other.
        self.kg.nodes.pop("equiv:exact")
        self.kg._index_node({
            "id": "equiv:approved", "class": "VendorEquivalence",
            "specified_model": "4040XP", "proposed_vendor": "Approved",
            "proposed_model": "RIGHT - approved",
            "estimator_approved": True, "confidence": 0.6,
        })
        found = self.kg.lookup_vendor_equivalence("LCN 4040XP closer")
        self.assertEqual(found["proposed_model"], "RIGHT - approved")

    def test_equivalence_lookup_still_returns_none_when_nothing_matches(self):
        self.assertIsNone(self.kg.lookup_vendor_equivalence("ZZQQ-9999 nonexistent"))
        self.assertIsNone(self.kg.lookup_vendor_equivalence(""))

    def test_wall_to_throat_reads_the_field_the_graph_actually_has(self):
        """resolve_wall_to_throat read node['confidence'] while the schema documented
        'confidence_score' — settled on 'confidence' in both."""
        res = self.kg.resolve_wall_to_throat("3-5/8 metal stud with 5/8 Type X drywall")
        self.assertEqual(res["recommended_throat"], '5-7/8"')
        self.assertEqual(res["source"], "WallTypeMapping")
        self.assertGreater(res["confidence"], 0.0)

        masonry = self.kg.resolve_wall_to_throat("8 inch CMU block")
        self.assertEqual(masonry["recommended_throat"], '5-3/4"')

    def test_learn_from_quote_rejects_an_unknown_brand(self):
        res = self.kg.learn_from_quote(
            {"door_lines": [{"hw_set": "HW-1"}]}, brand="Brand That Does Not Exist")
        self.assertEqual(res["status"], "ignored")

    def test_save_round_trips_without_loss(self):
        self.kg.learn_from_correction({
            "specified_callout": "LCN 4040XP",
            "copilot_initial_match": "4040XP Door Closer",
            "estimator_override": "Hager 5200 ALM",
            "reason": "direct equal approved",
        })
        reloaded = okf.OKFKnowledgeGraph(self.path)
        self.assertEqual(len(reloaded.nodes), len(self.kg.nodes))
        self.assertEqual(reloaded.validation_errors, [])
        self.assertEqual(reloaded.metadata["total_nodes"], len(reloaded.nodes))


class TestDutchBrosUnderScoping(unittest.TestCase):
    """Regressions from the Dutch Bros Yorktown VA quote (2026-08-10 audit).

    That package totalled $107.12 for four openings against ~$11,842 of real doors, and
    the audit gate passed it: every line had a cost_source and a citation, so nothing
    asked whether the line delivered what it described. Each test below is one way that
    quote lied, and each failed before the gate was extended.
    """

    # Hardware Group 1 as sheet A2.2 actually defines it. Only the threshold was priced.
    GROUP_1 = [
        {"component": "Hinge - Ives 700 83in 630"},
        {"component": "Door Closer - LCN 4040XP"},
        {"component": "Lockset - Alarm Lock ETDL27R1G/26DV 99"},
        {"component": "Panic Hardware - Von Duprin 99EO 42in 626"},
        {"component": "Kick Plate - Ives 8400 40x30 630"},
        {"component": "Threshold - Pemko 275A 42in", "ext_sale": 32.19},
        {"component": "Door Shoe - Zero 39A Sweep 42in"},
        {"component": "Door Seal - Zero 188S BK 18ft"},
        {"component": "Floor Stop - Ives FS43 626"},
    ]

    BASE = {"cost_source": "catalog_list_x_multiplier",
            "cost_source_detail": "Pemko 2026 p13, 275A, 0.45 mult",
            "quantity_source": "schedule:A2.2 row 01"}

    def test_hardware_group_with_only_a_threshold_priced_is_blocked(self):
        line = {"tag": "01", "quantity": 1, "ext_sale": 32.19,
                "description": "Hardware Group 1", "hardware_group": "GROUP 1",
                "components": self.GROUP_1, **self.BASE}
        res = engine.format_cbc_proposal("Dutch Bros", [line], [], state="VA")
        self.assertFalse(res["audit_passed"])
        problems = " ".join(f["problem"] for f in res["audit_failures"])
        self.assertIn("9 components", problems)
        self.assertIn("8 neither priced nor excluded", problems)

    def test_group_components_excluded_explicitly_are_accounted(self):
        """Not-carried is a real answer. Tagged components must not trip the gate."""
        comps = []
        for c in self.GROUP_1:
            c = dict(c)
            if "ext_sale" not in c:
                c["exclusion"] = "[not carried on shelf - outside RFQ required]"
            comps.append(c)
        line = {"tag": "01", "quantity": 1, "ext_sale": 32.19,
                "description": "Hardware Group 1", "hardware_group": "GROUP 1",
                "components": comps, **self.BASE}
        res = engine.format_cbc_proposal("Dutch Bros", [line], [], state="VA")
        self.assertTrue(res["audit_passed"], res["audit_failures"])

    def test_group_named_without_components_is_blocked(self):
        line = {"tag": "02", "quantity": 1, "ext_sale": 27.59,
                "description": "3ft x 7ft HM/HMD Door, Hardware Group 2", **self.BASE}
        res = engine.format_cbc_proposal("Dutch Bros", [line], [], state="VA")
        self.assertFalse(res["audit_passed"])
        self.assertTrue(any("no enumerated components" in f["problem"]
                            for f in res["audit_failures"]))

    def test_described_door_assembly_never_priced_is_blocked(self):
        """The single largest miss: every door line described an HM/HMD door and paid
        only for its threshold. The leaf and frame were never priced or RFQ'd."""
        line = {"tag": "01", "quantity": 1, "ext_sale": 32.19,
                "description": "3ft-6in x 7ft-0in hollow metal door and frame",
                "components": [{"component": "Threshold", "ext_sale": 32.19}],
                **self.BASE}
        res = engine.format_cbc_proposal("Dutch Bros", [line], [], state="VA")
        self.assertFalse(res["audit_passed"])
        self.assertTrue(any("no priced or excluded door/frame assembly" in f["problem"]
                            for f in res["audit_failures"]))

    def test_quantity_without_provenance_is_blocked(self):
        """PA-51 grab bars were quoted qty 1 in three invented sizes. The schedule row
        states neither - it says 'SIZE DEPENDANT ON INSTALLATION LOCATION'."""
        line = {"tag": "PA-51", "quantity": 1, "ext_sale": 48.75,
                "description": "Straight Grab Bar - Bobrick B-5806",
                "cost_source": "catalog_list_x_multiplier",
                "cost_source_detail": "Bobrick 2020 p15, net cost each"}
        res = engine.format_cbc_proposal("Dutch Bros", [], [line], state="VA")
        self.assertFalse(res["audit_passed"])
        self.assertTrue(any("no provenance" in f["problem"]
                            for f in res["audit_failures"]))

    def test_size_in_description_needs_a_source(self):
        line = {"tag": "PA-51", "quantity": 1, "ext_sale": 48.75,
                "description": 'Straight Grab Bar 18" - Bobrick B-5806x18',
                "quantity_source": "tag_count:A5.1",
                "cost_source": "catalog_list_x_multiplier",
                "cost_source_detail": "Bobrick 2020 p15"}
        res = engine.format_cbc_proposal("Dutch Bros", [], [line], state="VA")
        self.assertFalse(res["audit_passed"])
        self.assertTrue(any("no size_source" in f["problem"]
                            for f in res["audit_failures"]))

    def test_undisclosed_substitution_is_blocked(self):
        """The finish schedule specifies Marlite S-100G. The quote priced NUDO LP-F9 and
        presented it as a direct catalog hit."""
        line = {"tag": "WF-1", "quantity": 41, "ext_sale": 3439.08,
                "description": "Class C FRP 4x10 wall panel",
                "specified_manufacturer": "MARLITE", "manufacturer": "NUDO",
                "quantity_source": "vision:A2.1", "size_source": "schedule:A2.1",
                "cost_source": "catalog_list_x_multiplier",
                "cost_source_detail": "NUDO 5-11-26 p1"}
        res = engine.format_cbc_proposal("Dutch Bros", [], [], [line], state="VA")
        self.assertFalse(res["audit_passed"])
        self.assertTrue(any("substitution_note" in f["problem"]
                            for f in res["audit_failures"]))

    def test_missing_state_is_blocked_not_defaulted(self):
        """`state` used to default to OH, which taxed this Virginia job at Ohio's 8%."""
        line = {"tag": "01", "quantity": 1, "ext_sale": 100.0,
                "description": "Threshold", **self.BASE}
        res = engine.format_cbc_proposal("Dutch Bros", [line], [])
        self.assertFalse(res["audit_passed"])
        self.assertTrue(any(f["block"] == "tax" for f in res["audit_failures"]))

    def test_virginia_is_not_taxed(self):
        line = {"tag": "01", "quantity": 1, "ext_sale": 100.0,
                "description": "Threshold", **self.BASE}
        res = engine.format_cbc_proposal("Dutch Bros", [line], [], state="VA")
        self.assertEqual(res["sales_tax_rate"], 0.0)
        self.assertEqual(res["sales_tax_amount"], 0.0)
        self.assertTrue(res["audit_passed"], res["audit_failures"])


class TestUnpricedLinesCanBeStated(unittest.TestCase):
    """An item with no cost must be expressible, or the audit deadlocks.

    Every value in COST_SOURCES answers "how was this cost obtained", which is unanswerable
    for a 10 44 00 extinguisher cabinet - nobody on the shelf sells one. The DTGO Popeyes
    run stalled exactly there: the estimate was correct, the honest answer was to leave
    cost_source blank, and blank was what the audit rejected. Three retries, same three
    lines, no way through.
    """

    BASE = {"quantity": 1, "quantity_source": "schedule:A6.1 row 1",
            "cost_source_detail": "searched 10 44 00 across the shelf; no vendor carries it"}

    def test_not_carried_line_passes_at_zero(self):
        line = {"tag": "FEC-1", "ext_sale": 0.0,
                "description": "Semi-recessed fire extinguisher cabinet",
                "cost_source": "not_carried", **self.BASE}
        res = engine.format_cbc_proposal("DTGO", [], [line], state="OH")
        self.assertTrue(res["audit_passed"], res["audit_failures"])

    def test_owner_supplied_and_excluded_are_expressible(self):
        for src in ("owner_supplied", "excluded"):
            with self.subTest(cost_source=src):
                line = {"tag": "PA-61", "ext_sale": 0.0, "description": "Soap dispenser",
                        "cost_source": src, **self.BASE}
                res = engine.format_cbc_proposal("DTGO", [], [line], state="OH")
                self.assertTrue(res["audit_passed"], res["audit_failures"])

    def test_no_cost_source_may_not_carry_money(self):
        """The escape hatch must not become a way to bank a number with no provenance."""
        line = {"tag": "FEC-1", "ext_sale": 250.0,
                "description": "Semi-recessed fire extinguisher cabinet",
                "cost_source": "not_carried", **self.BASE}
        res = engine.format_cbc_proposal("DTGO", [], [line], state="OH")
        self.assertFalse(res["audit_passed"])
        self.assertTrue(any("has no cost" in f["problem"] for f in res["audit_failures"]))

    def test_blank_cost_source_still_fails_and_says_how_to_fix_it(self):
        line = {"tag": "CH-1", "ext_sale": 0.0, "description": "Heavy-duty coat hook",
                **self.BASE}
        res = engine.format_cbc_proposal("DTGO", [], [line], state="OH")
        self.assertFalse(res["audit_passed"])
        fix = " ".join(f["fix"] for f in res["audit_failures"])
        self.assertIn("not_carried", fix, "the failure must name the way out of the deadlock")

    def test_uncosted_door_does_not_also_owe_an_assembly_line(self):
        """The checks that predate NO_COST_SOURCES must honour it.

        A door nobody on the shelf sells, declared not_carried at 0, was still failing
        "description names 'hm door' but the line carries no priced or excluded door/frame
        assembly" - a second deadlock behind the first.
        """
        line = {"tag": "103", "ext_sale": 0.0,
                "description": "3070 HM door and frame, Hardware Group 1",
                "cost_source": "not_carried", **self.BASE}
        res = engine.format_cbc_proposal("DTGO", [line], [], state="OH")
        self.assertTrue(res["audit_passed"], res["audit_failures"])

    def test_a_priced_door_still_owes_its_hardware_group(self):
        """The exemption is for lines carrying no money. The Dutch Bros miss - a Group 1
        opening priced at its threshold alone - must still fail."""
        line = {"tag": "01", "ext_sale": 32.19,
                "description": "3-6 x 7-0 HM/HMD Door, Hardware Group 1",
                "hardware_group": "GROUP 1",
                "components": [{"component": "Threshold", "ext_sale": 32.19},
                               {"component": "LCN 4040XP closer"},
                               {"component": "Von Duprin 99EO panic"}],
                "cost_source": "catalog_list_x_multiplier", **self.BASE}
        res = engine.format_cbc_proposal("DTGO", [line], [], state="OH")
        self.assertFalse(res["audit_passed"])
        self.assertTrue(any("neither priced nor excluded" in f["problem"]
                            for f in res["audit_failures"]))

    def test_unknown_cost_source_is_still_rejected(self):
        line = {"tag": "X", "ext_sale": 0.0, "description": "thing",
                "cost_source": "made_up", **self.BASE}
        res = engine.format_cbc_proposal("DTGO", [], [line], state="OH")
        self.assertFalse(res["audit_passed"])
        self.assertTrue(any("unknown cost_source" in f["problem"] for f in res["audit_failures"]))


class TestMemoryFilesParse(unittest.TestCase):
    """The memory files are the workspace's long-term state, and they are hand-edited.

    `memory/active_project.json` carried two stray closing braces for long enough that
    the memory page silently empty-stated instead of erroring - a malformed record looks
    exactly like an empty one to every reader.
    """

    ROOT = Path(__file__).resolve().parents[3] / "memory"

    def test_json_files_parse(self):
        if not self.ROOT.is_dir():
            self.skipTest("memory/ not present")
        for path in sorted(self.ROOT.rglob("*.json")):
            with self.subTest(file=path.name):
                json.loads(path.read_text(encoding="utf-8"))

    def test_jsonl_records_parse(self):
        """One object per line, `//` comment lines allowed - the readers skip those
        deliberately (catint/overrides.py), so the check has to match that contract."""
        if not self.ROOT.is_dir():
            self.skipTest("memory/ not present")
        for path in sorted(self.ROOT.rglob("*.jsonl")):
            for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                line = line.strip()
                if not line or line.startswith("//"):
                    continue
                with self.subTest(file=path.name, line=n):
                    json.loads(line)


class TestMCPToolWrappers(unittest.TestCase):
    """The tools the agent actually calls, not the functions behind them.

    Every other test here exercises `engine.*` directly. `server.*` is a separate
    signature, and it drifted: the wrapper carried `state="OH"` for long enough that the
    Virginia-taxed-at-Ohio's-rate bug was live on the only path an agent can reach, while
    `test_missing_state_is_blocked_not_defaulted` passed against the engine underneath it.
    """

    def setUp(self):
        try:
            from cbc_engine import server
        except ImportError as exc:                     # mcp not installed
            self.skipTest(f"cbc_engine.server unavailable: {exc}")
        self.server = server

    LINE = {"tag": "01", "quantity": 1, "ext_sale": 100.0, "description": "Threshold",
            "cost_source": "catalog_list_x_multiplier",
            "cost_source_detail": "Pemko 2026 p13, 0.45 mult",
            "quantity_source": "schedule:A2.2 row 01"}

    def test_state_has_no_default_at_the_tool_boundary(self):
        res = self.server.format_cbc_proposal("Dutch Bros", [dict(self.LINE)], [])
        self.assertEqual(res["sales_tax_amount"], 0.0,
                         "omitting state must not silently apply Ohio's rate")
        self.assertFalse(res["audit_passed"])
        self.assertTrue(any(f["block"] == "tax" for f in res["audit_failures"]),
                        res["audit_failures"])

    def test_state_still_taxes_when_it_is_read(self):
        for state, expected in (("OH", 8.0), ("KY", 6.5), ("VA", 0.0)):
            with self.subTest(state=state):
                res = self.server.format_cbc_proposal(
                    "Dutch Bros", [dict(self.LINE)], [], state=state)
                self.assertEqual(res["sales_tax_amount"], expected)
                self.assertTrue(res["audit_passed"], res["audit_failures"])

    def test_frp_waste_default_comes_from_the_engine_constants(self):
        """Not restated in the wrapper - FRP_CONSTANTS is the single source, and CBC has
        still to confirm it (Open Item 5)."""
        self.assertEqual(
            self.server.calculate_frp_takeoff(perimeter_lf=100.0)["waste_pct"],
            engine.FRP_CONSTANTS["waste_pct"])


if __name__ == "__main__":
    unittest.main()


