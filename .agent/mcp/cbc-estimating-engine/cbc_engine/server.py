"""CBC Estimating Engine MCP Server.

Deterministic commercial estimating tools for Construction Building Components
(CBC / Hamilton Parker). All pricing math, vendor multiplier lookups, margin
frameworks, and reference conversions are deterministic — no LLM inference.
"""

import asyncio
import json
from typing import Any, Dict, List, Optional

from mcp.server.mcpserver import MCPServer

from . import engine, okf

mcp = MCPServer(
    name="cbc-estimating-engine",
    instructions=(
        "Deterministic pricing engine for CBC / Hamilton Parker commercial "
        "estimating. Handles quote math (Cost / (1-Margin)), vendor multiplier "
        "tiers, margin bands, finish translation, frame throat derivation, FRP "
        "takeoff, hardware set expansion, and proposal formatting. "
        "Prices NEVER come from this engine — they come from catalog-intelligence. "
        "This engine provides the MATH and REFERENCE DATA only.\n"
        "RULES THAT PREVENT WRONG ANSWERS:\n"
        "1. Never invent a cost, margin, multiplier, or adder. Call the tools; if "
        "inputs are missing, return that fact — do not fill the gap.\n"
        "2. Every priced line must carry cost_source and cost_source_detail. The "
        "audit gate rejects lines without them.\n"
        "3. Never treat a list price as net cost. Callers supply cost already "
        "resolved via catalog-intelligence and price_basis / already_net.\n"
        "4. format_cbc_proposal audit failures are blocking — fix the named lines; "
        "do not bypass the gate."
    ),
)


@mcp.tool()
def calculate_quote_line(
    cost: float,
    margin: float,
    quantity: int = 1,
    cost_source: str = "not_specified",
    cost_source_detail: str = "",
) -> Dict[str, Any]:
    """Calculate Sale $ EA = Cost / (1 - Margin) with extended totals and cost-source audit trail."""
    return engine.calculate_quote_line(
        cost=cost, margin=margin, quantity=quantity,
        cost_source=cost_source, cost_source_detail=cost_source_detail,
    )


@mcp.tool()
def lookup_vendor_multiplier(vendor: str) -> Dict[str, Any]:
    """Lookup CBC multiplier tier, basis (list vs net), and sourcing rules. Flags wholesalers needing manual entry."""
    return engine.lookup_vendor_multiplier(vendor=vendor)


@mcp.tool()
def get_margin_band(
    product_category: str,
    customer: Optional[str] = None,
    override_margin: Optional[float] = None,
    override_reason: str = "",
) -> Dict[str, Any]:
    """Retrieve standard CBC margin rate and divisor for a product category.

    Precedence, most specific first: `override_margin` > customer programme > category
    band. Requirements 6.1 / FR-5 make margin an editable default — a Banner/SecLock buy
    carries less margin than a direct one — so pass `override_margin` with an
    `override_reason` and the deviation from standard is recorded on the result.
    """
    return engine.get_margin_band(
        product_category=product_category,
        customer=customer,
        override_margin=override_margin,
        override_reason=override_reason,
    )


@mcp.tool()
def convert_finish_code(finish_code: str) -> Dict[str, Any]:
    """Translate US <-> BHMA finish codes and flag premium/lead-time finishes."""
    return engine.convert_finish_code(finish_code=finish_code)


@mcp.tool()
def calculate_frame_throat(
    wall_type: str,
    stud_size_in: Optional[float] = None,
    drywall_layers: Optional[str] = None,
) -> Dict[str, Any]:
    """Derive standard HM frame throat (5-5/8, 5-3/4, 5-7/8, 7-3/4, 8-1/4) from wall construction."""
    return engine.calculate_frame_throat(
        wall_type=wall_type, stud_size_in=stud_size_in, drywall_layers=drywall_layers,
    )


@mcp.tool()
def parse_door_size(size_code: str) -> Dict[str, Any]:
    """Parse 4-digit door size shorthand (3070 = 3'-0\" x 7'-0\") into dimensional components."""
    return engine.parse_door_size(size_code=size_code)


@mcp.tool()
def calculate_frp_takeoff(
    perimeter_lf: float,
    inside_corners: int = 0,
    outside_corners: int = 0,
    wall_height_ft: float = 9.0,
    sheet_width_ft: float = 4.0,
    waste_pct: Optional[float] = None,
) -> Dict[str, Any]:
    """Calculate Division 06 FRP sheets, trims, rivets, and adhesive from room perimeter."""
    return engine.calculate_frp_takeoff(
        perimeter_lf=perimeter_lf, inside_corners=inside_corners,
        outside_corners=outside_corners, wall_height_ft=wall_height_ft,
        sheet_width_ft=sheet_width_ft, waste_pct=waste_pct,
    )


@mcp.tool()
def expand_hardware_set(
    set_callout: str,
    door_size: str = "3070",
    handing: str = "LH",
    fire_rating: Optional[str] = None,
    finish: str = "626",
    keyway: Optional[str] = None,
    core_type: Optional[str] = None,
) -> Dict[str, Any]:
    """Expand hardware group into stock CBC components. Returns models only — prices come from catalog-intelligence."""
    return engine.expand_hardware_set(
        set_callout=set_callout, door_size=door_size, handing=handing,
        fire_rating=fire_rating, finish=finish, keyway=keyway, core_type=core_type,
    )


@mcp.tool()
def lite_louver_lookup_plan(
    glazing_type: str,
    lite_size: str,
    door_size: str = "3070",
    vendor: str = "NGP",
) -> Dict[str, Any]:
    """Get lite/louver pricing lookup instructions for NGP, PEMKO, or Rockwood catalogs (NR-1)."""
    return engine.lite_louver_lookup_plan(
        glazing_type=glazing_type, lite_size=lite_size,
        door_size=door_size, vendor=vendor,
    )


@mcp.tool()
def format_cbc_proposal(
    project_name: str,
    door_lines: List[Dict[str, Any]],
    accessories_lines: List[Dict[str, Any]],
    frp_lines: Optional[List[Dict[str, Any]]] = None,
    alternates_lines: Optional[List[Dict[str, Any]]] = None,
    state: Optional[str] = None,
    sales_tax_rate: Optional[float] = None,
) -> Dict[str, Any]:
    """Assemble Phase 6 draft proposal with subtotals, tax (OH/KY), and DRAFT status for estimator review.

    `state` has NO default, and must not be given one here. It defaulted to "OH" in this
    wrapper long after `engine.format_cbc_proposal` had removed its own default, so every
    call that omitted it taxed the job at Ohio's 8% AND skipped the audit failure that says
    the state was never read. Read it off the cover sheet title block - the SITE address,
    not the franchisor's or architect's office sitting beside it.
    """
    return engine.format_cbc_proposal(
        project_name=project_name, door_lines=door_lines,
        accessories_lines=accessories_lines, frp_lines=frp_lines,
        alternates_lines=alternates_lines, state=state,
        sales_tax_rate=sales_tax_rate,
    )


@mcp.tool()
def route_model_for_task(
    task_type: str,
    vision_need: Optional[str] = None,
    has_conflicts: bool = False,
    is_fire_rated_or_complex: bool = False,
    opening_count: int = 1,
) -> Dict[str, Any]:
    """Classify how much effort an estimating step is allowed to cost: routine | deliberate | visual.

    Effort tiers, not models. Model selection belongs to the user in Antigravity's model
    picker and nothing here can switch it.
    """
    return engine.route_model_for_task(
        task_type=task_type,
        vision_need=vision_need,
        has_conflicts=has_conflicts,
        is_fire_rated_or_complex=is_fire_rated_or_complex,
        opening_count=opening_count,
    )


@mcp.tool()
def execute_sandbox_script(
    script_name: str,
    code_content: Optional[str] = None,
    args: Optional[List[str]] = None,
    timeout_seconds: int = 30,
) -> Dict[str, Any]:
    """Execute an agent-written Python script safely in the isolated sandbox environment without modifying root workspace files."""
    return engine.execute_sandbox_script(
        script_name=script_name,
        code_content=code_content,
        args=args,
        timeout_seconds=timeout_seconds,
    )


@mcp.tool()
def check_cost_freshness(cost_date: str, as_of: Optional[str] = None) -> Dict[str, Any]:
    """Classify a P21 last-PO cost by age (fresh/review/stale/discard) per CBC's freshness rule."""
    return engine.check_cost_freshness(cost_date=cost_date, as_of=as_of)


# --- OKF knowledge graph ---------------------------------------------------
# These were documented as mandatory workflow steps but were reachable only from a sandbox
# script, so the continuous-learning loop could never actually run.

@mcp.tool()
def okf_query(context_type: str, query: str) -> Dict[str, Any]:
    """Query the OKF graph. context_type: brand_package | frame_throat | vendor_substitution | uncarried.

    Returns learned patterns only, never prices — verify any product against
    catalog-intelligence before quoting it.
    """
    return okf.graph().get_smart_recommendation(context_type=context_type, query=query)


@mcp.tool()
def okf_hardware_set(set_id: str) -> Dict[str, Any]:
    """Components of a learned hardware set template. Identity only; prices come from the catalog."""
    components = okf.graph().get_hardware_set_expansion(set_id)
    return {
        "set_id": set_id,
        "components": components,
        "found": bool(components),
        "note": "No prices. Look each model up with catalog-intelligence and apply the "
                "vendor multiplier. The spec's own hardware schedule outranks this template.",
    }


@mcp.tool()
def okf_learn_from_quote(
    door_lines: List[Dict[str, Any]],
    brand: str = "",
    accessories_lines: Optional[List[Dict[str, Any]]] = None,
    frp_lines: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Phase 6: reinforce the brand/hardware-set patterns a completed proposal actually used."""
    return okf.graph().learn_from_quote(
        {"door_lines": door_lines,
         "accessories_lines": accessories_lines or [],
         "frp_lines": frp_lines or []},
        brand=brand,
    )


@mcp.tool()
def okf_learn_from_correction(
    specified_callout: str,
    estimator_override: str,
    copilot_initial_match: str = "",
    reason: str = "",
    division: str = "08",
) -> Dict[str, Any]:
    """Ingest an estimator override from memory/corrections.jsonl into the graph.

    Creates an EstimatorCorrectionPattern plus its SUPERSEDES / SUBSTITUTED_BY edges.
    Confidence starts below 1.0 and rises as the same override is applied again.
    """
    return okf.graph().learn_from_correction({
        "specified_callout": specified_callout,
        "estimator_override": estimator_override,
        "copilot_initial_match": copilot_initial_match,
        "reason": reason,
        "division": division,
    })


@mcp.tool()
def okf_graph_status() -> Dict[str, Any]:
    """Graph size, learning cycles, and any schema violations found on load."""
    g = okf.graph(reload=True)
    by_class: Dict[str, int] = {}
    for node in g.nodes.values():
        by_class[node.get("class", "GenericEntity")] = \
            by_class.get(node.get("class", "GenericEntity"), 0) + 1
    return {
        "graph_path": str(g.graph_path),
        "metadata": g.metadata,
        "nodes": len(g.nodes),
        "nodes_by_class": by_class,
        "edges": sum(len(e) for e in g.outgoing_edges.values()),
        "validation_errors": g.validation_errors,
        "healthy": not g.validation_errors,
    }


def main():
    asyncio.run(mcp.run_stdio_async())


if __name__ == "__main__":
    main()


