"""Unit tests for CBC estimating engine."""

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
    "scripts/touch_one.py",
    "workspace/test_output.txt",
    "outputs/touched_one.txt",
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
                 "cost_source_detail": "Hager PB#18 p42, 0.29 mult"}
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
        }]
        ok = engine.format_cbc_proposal("Test", sourced, [], state="OH")
        self.assertTrue(ok["audit_passed"])
        self.assertIn("DRAFT", ok["status"])
        self.assertEqual(ok["sales_tax_amount"], 8.0)
        self.assertIsNone(ok["freight"]["amount"])          # FR-7 / Open Item 1

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


if __name__ == "__main__":
    unittest.main()


