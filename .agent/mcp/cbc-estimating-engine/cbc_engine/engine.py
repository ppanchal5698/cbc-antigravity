"""Core deterministic estimating and pricing engine for Construction Building Components (CBC).

Implements all formulas, lookups, margin frameworks, multiplier tiers,
and conversion rules agreed in docs/requirements.md.

DESIGN RULES:
- Prices NEVER come from this engine. They come from catalog-intelligence.
  This engine stores reference models, multiplier tiers, and margin math only.
- Adder values marked PENDING_CBC_DATA must be confirmed from Hager price book (NR-7).
- Customer special margins must be confirmed from CBC (NR-9).
"""

from __future__ import annotations

import math
import os
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# 1. Quote Calculation Logic (Requirements §4 & 5.0)
# ---------------------------------------------------------------------------

# Requirements 6.2 / FR-6. A line whose cost cannot name one of these did not come from a
# sourcing path CBC recognises, and does not belong in a proposal.
COST_SOURCES = (
    "catalog_list_x_multiplier",
    "p21_last_po",
    "manual_wholesaler_net",
    "vendor_rfq",
    "custom_fabricator",
    "not_specified",
)


def calculate_quote_line(
    cost: float,
    margin: float,
    quantity: int = 1,
    cost_source: str = "not_specified",
    cost_source_detail: str = "",
) -> Dict[str, Any]:
    """Calculate unit sale price and extended totals.

    Formula:
      Sale $ EA = Cost / (1 - Margin)
      Ext Sale  = Sale $ EA * Quantity
      Ext Cost  = Cost * Quantity
      Ext Margin $ = Ext Sale - Ext Cost
      Effective Margin % = (Ext Margin $ / Ext Sale) * 100

    cost_source must be one of:
      catalog_list_x_multiplier | p21_last_po | manual_wholesaler_net |
      vendor_rfq | custom_fabricator | not_specified
    """
    if margin >= 1.0:
        raise ValueError(f"Margin must be less than 1.0 (got {margin})")
    if margin < 0:
        raise ValueError(f"Margin cannot be negative (got {margin})")
    if quantity < 0:
        raise ValueError(f"Quantity cannot be negative (got {quantity})")
    if cost < 0:
        raise ValueError(f"Cost cannot be negative (got {cost})")
    if cost_source not in COST_SOURCES:
        raise ValueError(
            f"Unknown cost_source {cost_source!r}. Must be one of: {', '.join(COST_SOURCES)}"
        )

    divisor = 1.0 - margin
    sale_ea = round(cost / divisor, 2)
    ext_sale = round(sale_ea * quantity, 2)
    ext_cost = round(cost * quantity, 2)
    ext_margin_dollars = round(ext_sale - ext_cost, 2)
    effective_margin_pct = (
        round((ext_margin_dollars / ext_sale * 100.0), 2) if ext_sale > 0 else 0.0
    )

    return {
        "unit_cost": round(cost, 2),
        "margin_rate": margin,
        "divisor": round(divisor, 4),
        "quantity": quantity,
        "sale_ea": sale_ea,
        "ext_sale": ext_sale,
        "ext_cost": ext_cost,
        "ext_margin_dollars": ext_margin_dollars,
        "effective_margin_pct": effective_margin_pct,
        "cost_source": cost_source,
        "cost_source_detail": cost_source_detail,
        "formula": f"${cost:.2f} / (1 - {margin:.2f}) = ${sale_ea:.2f} EA",
    }


# Requirements 6.2: "cost older than ~6-8 months is unreliable; 3-4 years must be
# discarded", and the estimator session added "last-PO if sold <1 yr & no price increase".
FRESHNESS_DAYS = {"fresh": 365, "review": 730}


def check_cost_freshness(cost_date: str, as_of: Optional[str] = None) -> Dict[str, Any]:
    """Classify a P21 last-PO cost by age: fresh | review | stale | discard.

    cost_date / as_of are ISO dates (YYYY-MM-DD). `as_of` defaults to today.
    """
    def _parse(value: str) -> date:
        return datetime.strptime(value.strip()[:10], "%Y-%m-%d").date()

    try:
        cost_day = _parse(cost_date)
    except (ValueError, AttributeError):
        return {
            "cost_date": cost_date,
            "status": "unknown",
            "usable": False,
            "guidance": "Cost date could not be parsed. Confirm the last-PO date in P21 "
                        "before using this cost, or source the line another way.",
        }

    today = _parse(as_of) if as_of else date.today()
    age_days = (today - cost_day).days

    if age_days < 0:
        status, usable, guidance = ("unknown", False, "Cost date is in the future — check it.")
    elif age_days <= FRESHNESS_DAYS["fresh"]:
        status, usable = "fresh", True
        guidance = "Under a year old. Usable, provided no price increase has landed since."
    elif age_days <= FRESHNESS_DAYS["review"]:
        status, usable = "review", True
        guidance = ("Over a year old. Check the vendor for a price increase before "
                    "quoting, or re-source from the current price book.")
    elif age_days <= 3 * 365:
        status, usable = "stale", False
        guidance = ("Two to three years old — treat as unreliable. Re-source from the "
                    "current price book or a vendor RFQ.")
    else:
        status, usable = "discard", False
        guidance = "Three years or older. Discard this cost; it must be re-sourced."

    return {
        "cost_date": cost_day.isoformat(),
        "as_of": today.isoformat(),
        "age_days": age_days,
        "age_months": round(age_days / 30.44, 1),
        "status": status,
        "usable": usable,
        "guidance": guidance,
    }


# ---------------------------------------------------------------------------
# 2. Vendor Multipliers & Sourcing Paths (Requirements §6.2, 6.3, 6.6)
# ---------------------------------------------------------------------------

VENDOR_TIERS = {
    "HAGER": {
        "vendor_name": "Hager Companies",
        "multiplier": 0.29,
        "basis": "list",
        "effective_date": "2026-03-02",
        "catalog_source": "Hager Price Book #18 / Hager Multipliers and Special Nets",
        "notes": "Standard '50 & 42' discount. ~75% of door hardware volume.",
        "sourcing_type": "direct",
        "adders": {
            "NRP": {
                "description": "Non-Removable Pin adder per hinge",
                "cost_adder": None,
                "data_source": "PENDING_CBC_DATA — NR-7: extract from Hager price book",
            },
            "ELECTRIFICATION": {
                "description": "Electric Latch Retraction / Power Prep adder per device",
                "cost_adder": None,
                "data_source": "PENDING_CBC_DATA — NR-7: extract from Hager price book",
            },
            "PREMIUM_FINISH": {
                "description": "Premium/lead-time finish adder (US32D, US10B, etc.)",
                "multiplier_factor": None,
                "data_source": "PENDING_CBC_DATA — NR-7: extract from Hager price book",
            },
        },
    },
    "ASI": {
        "vendor_name": "ASI American Specialties",
        "multiplier": 0.375,
        "basis": "list",
        "effective_date": "2026-01-12",
        "catalog_source": "ASI-Price-List - 1-12-26 - .375 Multiplier.pdf",
        "notes": "List price x 0.375 multiplier.",
        "sourcing_type": "direct",
    },
    "BOBRICK": {
        "vendor_name": "Bobrick Washroom Equipment",
        "multiplier": 1.0,
        "basis": "net",
        "effective_date": "2020-01-01",
        "catalog_source": "BOBRICK 2020 PRICE LIST.pdf",
        "notes": "Catalog columns are pre-computed NET COST EACH. Multiplier is 1.0.",
        "sourcing_type": "direct",
    },
    "GAMCO": {
        "vendor_name": "Gamco (A Division of Bobrick)",
        "multiplier": 1.0,
        "basis": "net",
        "effective_date": "2020-01-01",
        "catalog_source": "Gamco_Price_List_2020.pdf",
        "notes": "Catalog columns are pre-computed NET COST EACH. Multiplier is 1.0.",
        "sourcing_type": "direct",
    },
    "BRADLEY": {
        "vendor_name": "Bradley Corporation",
        "multiplier": 0.53,
        "basis": "list",
        "effective_date": "2026-01-01",
        "catalog_source": "26 price book WAD .53.pdf",
        "notes": "List price x 0.53 multiplier (WAD .53 tier).",
        "sourcing_type": "direct",
    },
    "PEMKO": {
        "vendor_name": "Pemko / Markar (Assa Abloy)",
        "multiplier": 0.45,
        "basis": "list",
        "effective_date": "2026-01-01",
        "catalog_source": "markar_and_pemko_price_book_2026.pdf / Account 4244636",
        "notes": "Buying program account discount tier.",
        "sourcing_type": "direct",
    },
    "NATIONAL GUARD PRODUCTS": {
        "vendor_name": "National Guard Products (NGP)",
        "multiplier": 0.45,
        "basis": "list",
        "effective_date": "2026-06-08",
        "catalog_source": "NGP Price List 6-8-2026 - .45 Multiplier.pdf",
        "notes": "List price x 0.45. Threshold formula: inches x per-ft-rate x 0.45.",
        "sourcing_type": "direct",
    },
    "ROCKWOOD": {
        "vendor_name": "Rockwood (Assa Abloy)",
        "multiplier": 0.55,
        "basis": "list",
        "effective_date": "2025-03-03",
        "catalog_source": "Rockwood Accessories - .55 Multiplier.pdf / Architectural",
        "notes": "Accessories catalog x 0.55. Architectural finish matrix requires get_page.",
        "sourcing_type": "direct",
    },
    "WORLD DRYER": {
        "vendor_name": "World Dryer",
        "multiplier": 0.339,
        "basis": "list",
        "effective_date": "2022-09-01",
        "catalog_source": "Copy of L-3World Dryer Pricing_9.2022_L3 - .339 MULTIPLIER.xlsx",
        "notes": "Level-3 discount tier. Price book is Excel; catalog-intelligence now "
                 "indexes it, and its rows carry price_basis (list / map / net).",
        "sourcing_type": "direct",
    },
    "NUDO": {
        "vendor_name": "NUDO Products",
        "multiplier": 1.0,
        "basis": "list",
        "effective_date": "2026-05-11",
        "catalog_source": "MIDWEST-EAST COAST FRP 5-11-26.pdf / VINYL MOLDINGS",
        "notes": "Direct sheet pricing ($/sheet) and moulding pricing ($/stick).",
        "sourcing_type": "direct",
    },
    # Wholesalers — manual price entry required (NR-2, FR-16)
    "BANNER SOLUTIONS": {
        "vendor_name": "Banner Solutions (Allegion Wholesaler)",
        "multiplier": None,
        "basis": "net",
        "effective_date": "Manual Quote",
        "catalog_source": "Wholesaler Portal / Banner Quote",
        "notes": "Wholesaler for Von Duprin, LCN, Schlage, Ives. MANUAL cost entry required.",
        "sourcing_type": "wholesaler",
        "manual_entry_prompt": "This line requires a manual net cost from Banner Solutions. Enter the distributor net, or mark as 'awaiting vendor quote'.",
    },
    "SECLOCK": {
        "vendor_name": "SecLock (Allegion Wholesaler)",
        "multiplier": None,
        "basis": "net",
        "effective_date": "Manual Quote",
        "catalog_source": "Wholesaler Portal / SecLock Quote",
        "notes": "Wholesaler for Von Duprin, LCN, Schlage, Ives. MANUAL cost entry required.",
        "sourcing_type": "wholesaler",
        "manual_entry_prompt": "This line requires a manual net cost from SecLock. Enter the distributor net, or mark as 'awaiting vendor quote'.",
    },
    "J2": {
        "vendor_name": "J2 Specialties",
        "multiplier": None,
        "basis": "net",
        "effective_date": "Manual Quote",
        "catalog_source": "Distributor Quote",
        "notes": "Accessories distributor. MANUAL cost entry required.",
        "sourcing_type": "wholesaler",
        "manual_entry_prompt": "This line requires a manual net cost from J2 Specialties.",
    },
    "PIONITE": {
        "vendor_name": "Pionite (Laminate Doors)",
        "multiplier": None,
        "basis": "net",
        "effective_date": "Manual Quote",
        "catalog_source": "Custom Layup Quote",
        "notes": "Laminate door vendor. MANUAL cost entry from fabricator quote.",
        "sourcing_type": "wholesaler",
        "manual_entry_prompt": "Pionite laminate door: manual fabricator quote required.",
    },
    "WILSONART": {
        "vendor_name": "Wilsonart (Laminate Doors)",
        "multiplier": None,
        "basis": "net",
        "effective_date": "Manual Quote",
        "catalog_source": "Custom Layup Quote",
        "notes": "Laminate door vendor. MANUAL cost entry from fabricator quote.",
        "sourcing_type": "wholesaler",
        "manual_entry_prompt": "Wilsonart laminate door: manual fabricator quote required.",
    },
}


# How a vendor is actually written on a drawing, in a hardware set, or by an estimator.
# Without these, lookup_vendor_multiplier("NGP") falls through to VENDOR_RFQ_REQUIRED and
# every threshold, sweep and gasket line silently loses its 0.45 multiplier.
VENDOR_ALIASES = {
    "NGP": "NATIONAL GUARD PRODUCTS",
    "NATIONAL GUARD": "NATIONAL GUARD PRODUCTS",
    "MARKAR": "PEMKO",
    "ASSA ABLOY": "ROCKWOOD",          # the two Assa Abloy lines on this shelf are
    "ASSA": "ROCKWOOD",                # Rockwood and Pemko; Rockwood is the default
    "BOBRICK/GAMCO": "BOBRICK",
    "AMERICAN SPECIALTIES": "ASI",
    "WORLDDRYER": "WORLD DRYER",
    "NUDO PRODUCTS": "NUDO",
    "BANNER": "BANNER SOLUTIONS",
    "SEC LOCK": "SECLOCK",
    "J2 SPECIALTIES": "J2",
    "HAGER COMPANIES": "HAGER",
}


def _resolve_vendor_key(vendor: str) -> Optional[str]:
    """Map a written vendor name onto a VENDOR_TIERS key, or None.

    Exact and alias matches first, then a *word-boundary* containment check. The old
    bare-substring test matched in both directions, so a one- or two-letter vendor string
    could land on an arbitrary tier.
    """
    norm = " ".join(vendor.strip().upper().replace("-", " ").split())
    if not norm:
        return None
    if norm in VENDOR_TIERS:
        return norm
    if norm in VENDOR_ALIASES:
        return VENDOR_ALIASES[norm]
    for alias, key in VENDOR_ALIASES.items():
        if alias in norm.split() or alias == norm:
            return key
    # Containment, but only on whole words and only for keys long enough to be meaningful.
    words = set(norm.split())
    for key in VENDOR_TIERS:
        key_words = set(key.split())
        if key_words <= words or (len(key) >= 4 and key in norm):
            return key
    return None


def lookup_vendor_multiplier(vendor: str) -> Dict[str, Any]:
    """Lookup CBC vendor multiplier tier, effective dates, and sourcing rules."""
    key = _resolve_vendor_key(vendor)
    if key:
        data = VENDOR_TIERS[key]
        result = {"matched_vendor": key, "input_vendor": vendor, **data}
        # Flag if this is a wholesaler requiring manual entry
        if data["sourcing_type"] == "wholesaler":
            result["action_required"] = "MANUAL_PRICE_ENTRY"
        return result
    return {
        "matched_vendor": vendor,
        "vendor_name": vendor,
        "multiplier": None,
        "basis": "unknown",
        "effective_date": "Unknown",
        "notes": "Vendor not on active shelf. Manual cost entry or vendor RFQ required.",
        "sourcing_type": "manual_rfq",
        "action_required": "VENDOR_RFQ_REQUIRED",
    }


# ---------------------------------------------------------------------------
# 3. Margin Framework by Product Type (Requirements §6.1)
# ---------------------------------------------------------------------------

MARGIN_BANDS = {
    "commodity": {
        "name": "Commodity (Doors, Metal Frames, Standard Hardware)",
        "margin": 0.27,
        "divisor": 0.73,
    },
    "restroom_partitions": {
        "name": "Restroom Partitions (Toilet Partitions)",
        "margin": 0.35,
        "divisor": 0.65,
    },
    "accessories": {
        "name": "Restroom / Washroom Accessories",
        "margin": 0.56,
        "divisor": 0.44,
        "note": "Derived from CBC project data; baseline was 35%.",
    },
    "specialty": {
        "name": "Specialty Items (Laminated Doors, Special Wood Doors)",
        "margin": 0.40,
        "divisor": 0.60,
    },
    "custom_built": {
        "name": "Custom-Built via Outside Fabricator",
        "margin": 0.25,
        "divisor": 0.75,
    },
}

# Only confirmed special-customer margins (NR-9 — CBC must provide the rest)
CUSTOMER_SPECIAL_MARGINS = {
    "wendys": {
        "commodity": 0.22,
        "accessories": 0.45,
        "description": "Wendy's national account special pricing (confirmed §6.1).",
    },
    # NR-9: Other customer-specific margins must be provided by CBC.
    # Do NOT add fabricated values for Cava, McDonald's, etc.
}


def get_margin_band(
    product_category: str,
    customer: Optional[str] = None,
    override_margin: Optional[float] = None,
    override_reason: str = "",
) -> Dict[str, Any]:
    """Retrieve CBC margin rate and divisor for a product category.

    Precedence, most specific first: explicit override > customer programme > category
    band. Category matching is ordered specific-to-generic — "custom laminate door" is a
    custom fabrication, not a commodity door, so "custom" and "laminate" must be tested
    before the "door" keyword that also appears in the string.
    """
    norm_cat = product_category.lower().replace("-", "_").replace(" ", "_")

    if "custom" in norm_cat or "fabricat" in norm_cat:
        matched_key = "custom_built"
    elif "laminate" in norm_cat or "specialty" in norm_cat or "special_wood" in norm_cat:
        matched_key = "specialty"
    elif "partition" in norm_cat:
        matched_key = "restroom_partitions"
    elif "accessor" in norm_cat or "dryer" in norm_cat or "washroom" in norm_cat:
        matched_key = "accessories"
    elif "door" in norm_cat or "frame" in norm_cat or "hardware" in norm_cat:
        matched_key = "commodity"
    else:
        matched_key = "commodity"
        for key in MARGIN_BANDS:
            if key in norm_cat or norm_cat in key:
                matched_key = key
                break

    base_band = MARGIN_BANDS[matched_key]
    margin = base_band["margin"]
    source = "category_band"

    if customer:
        cust_norm = customer.lower().replace("'", "").strip()
        if cust_norm in CUSTOMER_SPECIAL_MARGINS:
            cust_margins = CUSTOMER_SPECIAL_MARGINS[cust_norm]
            if matched_key in cust_margins:
                margin = cust_margins[matched_key]
                source = f"customer_programme:{cust_norm}"

    # Requirements 6.1 / FR-5: margin is an editable default, overridable on essentially
    # every quote by how the line was sourced (a Banner/SecLock buy carries less margin).
    if override_margin is not None:
        if not 0.0 <= override_margin < 1.0:
            raise ValueError(f"override_margin must be in [0, 1) (got {override_margin})")
        margin = override_margin
        source = "estimator_override"

    result = {
        "category_key": matched_key,
        "category_name": base_band["name"],
        "margin": margin,
        "divisor": round(1.0 - margin, 4),
        "margin_source": source,
        "standard_margin": base_band["margin"],
    }
    if source == "estimator_override":
        result["override_reason"] = override_reason or "not stated"
        result["deviation_from_standard"] = round(margin - base_band["margin"], 4)
    return result


# ---------------------------------------------------------------------------
# 4. Dual Finish Nomenclature Interpreter (NR-3, §7.5)
# ---------------------------------------------------------------------------

FINISH_MAP = {
    # US Code -> (BHMA Code, Description, Is Premium)
    "US26D": ("626", "Satin Chromium Plated", False),
    "626": ("US26D", "Satin Chromium Plated", False),
    "US26": ("625", "Bright Chromium Plated", True),
    "625": ("US26", "Bright Chromium Plated", True),
    "US32D": ("630", "Satin Stainless Steel", True),
    "630": ("US32D", "Satin Stainless Steel", True),
    "US32": ("629", "Bright Stainless Steel", True),
    "629": ("US32", "Bright Stainless Steel", True),
    "US10B": ("613", "Oil Rubbed Bronze", True),
    "613": ("US10B", "Oil Rubbed Bronze", True),
    "US10": ("612", "Satin Bronze", True),
    "612": ("US10", "Satin Bronze", True),
    "US3": ("605", "Bright Brass", True),
    "605": ("US3", "Bright Brass", True),
    "US4": ("606", "Satin Brass", True),
    "606": ("US4", "Satin Brass", True),
    "US15": ("619", "Satin Nickel Plated", True),
    "619": ("US15", "Satin Nickel Plated", True),
    "US19": ("622", "Flat Black", True),
    "622": ("US19", "Flat Black", True),
    "USP": ("600", "Primed for Painting", False),
    "600": ("USP", "Primed for Painting", False),
    "US28": ("628", "Satin Aluminum Clear Anodized", False),
    "628": ("US28", "Satin Aluminum Clear Anodized", False),
    "313AN": ("710", "Dark Bronze Anodized Aluminum", True),
    "710": ("313AN", "Dark Bronze Anodized Aluminum", True),
}


def convert_finish_code(finish_code: str) -> Dict[str, Any]:
    """Interpret dual finish nomenclature (US <-> BHMA) and flag premium finishes."""
    raw = finish_code.strip().upper().replace(" ", "")
    if raw in FINISH_MAP:
        alt_code, desc, is_prem = FINISH_MAP[raw]
        us_code = raw if raw.startswith("US") or raw in ("313AN", "USP") else alt_code
        bhma_code = alt_code if us_code == raw else raw
        return {
            "input_code": finish_code,
            "us_code": us_code,
            "bhma_code": bhma_code,
            "description": desc,
            "is_premium": is_prem,
            "lead_time_note": "Extended manufacturer lead time and finish adder likely."
            if is_prem
            else "Standard stock finish.",
        }
    return {
        "input_code": finish_code,
        "us_code": finish_code,
        "bhma_code": finish_code,
        "description": "Custom / Unmapped Finish",
        "is_premium": True,
        "lead_time_note": "Custom finish: confirm availability and adder with manufacturer.",
    }


# ---------------------------------------------------------------------------
# 5. Frame Depth by Wall Type (Requirements §7.0, Open Item 6)
# ---------------------------------------------------------------------------

STANDARD_FRAME_THROATS = [
    {"throat": '5-5/8"', "decimal": 5.625, "wall": "3-5/8\" stud + 1/2\" drywall", "use": "McDonald's / retail"},
    {"throat": '5-7/8"', "decimal": 5.875, "wall": "3-5/8\" stud + 5/8\" Type X drywall", "use": "Standard commercial"},
    {"throat": '5-3/4"', "decimal": 5.750, "wall": "Masonry / CMU / Block", "use": "Masonry openings"},
    {"throat": '7-3/4"', "decimal": 7.750, "wall": "Wood stud framing", "use": "Wood-frame partition"},
    {"throat": '8-1/4"', "decimal": 8.250, "wall": "6\" metal stud + 5/8\" drywall", "use": "Heavy chase / exterior"},
]


# A stud width as anyone actually writes it: `6"`, `6 inch`, `3-5/8"`, `2x6`, with an
# optional material word before `stud`. The old matcher tested for the literal substring
# `6" stud`, which does not appear in `6" metal stud + 5/8" drywall` — the exact wall
# STANDARD_FRAME_THROATS pairs with 8-1/4".
_STUD_RX = re.compile(
    r'(\d+(?:[-\s]\d+/\d+)?)\s*(?:"|”|in\b|inch(?:es)?\b)?\s*'
    r'(?:metal|steel|mtl|wood)?\s*studs?',
    re.I,
)


def _inches(text: str) -> float:
    """`6` -> 6.0, `3-5/8` -> 3.625. Whole number plus an optional fraction."""
    whole, _, frac = text.strip().replace(" ", "-").partition("-")
    value = float(whole)
    if "/" in frac:
        numerator, denominator = frac.split("/", 1)
        value += float(numerator) / float(denominator)
    return value


def stud_width_in(wall_description: str) -> Optional[float]:
    """Stud width in inches read out of a wall description, or None if it names none.

    Shared with okf.resolve_wall_to_throat so the graph's fallback heuristic and the
    engine's derivation cannot disagree about what a 6" stud looks like.
    """
    match = _STUD_RX.search(wall_description or "")
    if not match:
        return None
    try:
        return _inches(match.group(1))
    except (ValueError, ZeroDivisionError):
        return None


def calculate_frame_throat(
    wall_type: str,
    stud_size_in: Optional[float] = None,
    drywall_layers: Optional[str] = None,
) -> Dict[str, Any]:
    """Derive standard hollow metal frame depth/throat size from wall construction."""
    wt = wall_type.lower()
    all_sizes = [t["throat"] for t in STANDARD_FRAME_THROATS]
    stud_in = stud_size_in if stud_size_in is not None else stud_width_in(wt)

    if "masonry" in wt or "cmu" in wt or "block" in wt or "concrete" in wt:
        throat, dec, cat = '5-3/4"', 5.75, "Masonry / CMU"
    elif stud_in is not None and stud_in >= 6.0:
        throat, dec, cat = '8-1/4"', 8.25, "6\" Metal Stud Partition"
    elif "1/2" in wt and ("drywall" in wt or "gyp" in wt):
        throat, dec, cat = '5-5/8"', 5.625, "3-5/8\" Stud + 1/2\" Drywall"
    elif "wood" in wt:
        throat, dec, cat = '7-3/4"', 7.75, "Wood Stud Partition"
    else:
        throat, dec, cat = '5-7/8"', 5.875, "3-5/8\" Stud + 5/8\" Drywall (default)"

    return {
        "recommended_throat": throat,
        "decimal_in": dec,
        "wall_category": cat,
        "all_standards": all_sizes,
    }


# ---------------------------------------------------------------------------
# 6. Door Size Parsing (Requirements §7.1)
# ---------------------------------------------------------------------------

def parse_door_size(size_code: str) -> Dict[str, Any]:
    """Parse 4-digit door size shorthand into dimensional components.

    3070 = 3'-0" x 7'-0"
    3670 = 3'-6" x 7'-0"
    6070 = 6'-0" x 7'-0" (pair)
    3080 = 3'-0" x 8'-0"
    """
    code = size_code.strip().replace(" ", "").replace("x", "")
    if len(code) != 4 or not code.isdigit():
        return {
            "input": size_code,
            "parsed": False,
            "error": f"Cannot parse '{size_code}' as a 4-digit door size code.",
        }

    width_ft = int(code[0])
    width_in = int(code[1])  # second digit = inches (e.g. 0=0", 6=6", 8=8")
    height_ft = int(code[2])
    height_in = int(code[3])  # fourth digit = inches (e.g. 0=0", 6=6", 8=8")

    width_total_in = width_ft * 12 + width_in
    height_total_in = height_ft * 12 + height_in

    return {
        "input": size_code,
        "parsed": True,
        "width_ft": width_ft,
        "width_in": width_in,
        "height_ft": height_ft,
        "height_in": height_in,
        "width_total_in": width_total_in,
        "height_total_in": height_total_in,
        "display": f"{width_ft}'-{width_in}\" x {height_ft}'-{height_in}\"",
        "is_pair": width_total_in >= 60,
    }


# ---------------------------------------------------------------------------
# 7. FRP Wall Panel & Moulding Takeoff (FR-12, §3b, Open Item 5)
# ---------------------------------------------------------------------------

# PROVISIONAL. CBC Open Item 5 is still "Partial": "Vu360 + calculator confirmed for FRP;
# panel/waste/trim/adhesive conversion constants still to be provided." Nothing below has
# been confirmed by an estimator — these are working assumptions so a takeoff can be drafted
# at all, and every result carries the flag saying so. Replace the values, not the flag,
# when CBC supplies the real constants.
FRP_CONSTANTS = {
    "waste_pct": 10.0,
    "stick_length_ft": 10.0,
    "sheets_per_adhesive_pail": 8.0,
    "rivets_per_sheet": 30,
    "end_cap_sticks_per_perimeter_ft": 2.0 / 10.0,
    "provisional": True,
    "source": "Open Item 5 — pending CBC; not estimator-confirmed",
}


def calculate_frp_takeoff(
    perimeter_lf: float,
    inside_corners: int = 0,
    outside_corners: int = 0,
    wall_height_ft: float = 9.0,
    sheet_width_ft: float = 4.0,
    waste_pct: Optional[float] = None,
) -> Dict[str, Any]:
    """Calculate Division 06 FRP sheet, trim, and adhesive material takeoff.

    Geometry (perimeter, corners, height) comes from the drawings and is real. The
    conversion to quantities uses FRP_CONSTANTS, which CBC has NOT confirmed — the result
    carries `provisional: True` so every FRP line surfaces as review-required.
    """
    if perimeter_lf <= 0:
        raise ValueError(f"Perimeter must be > 0 (got {perimeter_lf})")

    k = FRP_CONSTANTS
    waste = k["waste_pct"] if waste_pct is None else waste_pct
    stick = k["stick_length_ft"]

    sheet_len_ft = 8.0 if wall_height_ft <= 8.0 else 10.0
    sheet_name = f'.090" Class C FRP {int(sheet_width_ft)}\'x{int(sheet_len_ft)}\' White Embossed'

    base_sheets = perimeter_lf / sheet_width_ft
    sheet_count = int(math.ceil(base_sheets * (1.0 + waste / 100.0)))

    div_bars = max(0, sheet_count - 1)
    end_caps_sticks = int(math.ceil(
        perimeter_lf * k["end_cap_sticks_per_perimeter_ft"]))
    adhesive_4gal_pails = int(math.ceil(sheet_count / k["sheets_per_adhesive_pail"]))
    rivets_count = sheet_count * k["rivets_per_sheet"]

    return {
        "perimeter_lf": perimeter_lf,
        "wall_height_ft": wall_height_ft,
        "sheet_spec": sheet_name,
        "sheet_count": sheet_count,
        "waste_pct": waste,
        "trims": {
            "division_bars_10ft": div_bars,
            "inside_corners_10ft": inside_corners,
            "outside_corners_10ft": outside_corners,
            "end_caps_j_moulding_10ft": end_caps_sticks,
            "adhesive_4gal_pails": adhesive_4gal_pails,
            "rivets": rivets_count,
        },
        "price_source": "NUDO catalog via catalog-intelligence (lookup required)",
        "provisional": True,
        "constants_used": {k2: v for k2, v in k.items() if k2 != "provisional"},
        "action_required": (
            "REVIEW — conversion constants (waste %, adhesive coverage, rivet count, trim "
            "stick lengths) are working assumptions, not CBC-confirmed (Open Item 5). "
            "Have the estimator confirm the quantities before they are priced."
        ),
    }


# ---------------------------------------------------------------------------
# 8. Hardware Set Expansion (Requirements §7.2, FR-3)
#    NOTE: No prices returned. Prices come from catalog-intelligence.
# ---------------------------------------------------------------------------

# Reference model numbers only — no prices
STOCK_HARDWARE_MODELS = {
    "hinges_standard": {"vendor": "Hager", "model": "BB1279 4.5x4.5", "multiplier_vendor": "HAGER"},
    "hinges_heavy_nrp": {"vendor": "Hager", "model": "BB1191 4.5x4.5 NRP", "multiplier_vendor": "HAGER"},
    "lockset_grade2": {"vendor": "Hager", "model": "3500 Series", "multiplier_vendor": "HAGER"},
    "lockset_grade1": {"vendor": "Hager", "model": "3400 Series", "multiplier_vendor": "HAGER"},
    "closer_grade1": {"vendor": "Hager", "model": "5200 Series", "multiplier_vendor": "HAGER"},
    "closer_standard": {"vendor": "Hager", "model": "5100 Series", "multiplier_vendor": "HAGER"},
    "exit_device_rim": {"vendor": "Hager", "model": "4500 Series Rim Exit", "multiplier_vendor": "HAGER"},
    "kick_plate": {"vendor": "Rockwood", "model": "K1050", "multiplier_vendor": "ROCKWOOD"},
    "wall_stop": {"vendor": "Hager", "model": "236W", "multiplier_vendor": "HAGER"},
    "floor_stop": {"vendor": "Hager", "model": "241F", "multiplier_vendor": "HAGER"},
    "threshold": {"vendor": "National Guard Products", "model": "412S", "multiplier_vendor": "NATIONAL GUARD PRODUCTS"},
    "door_sweep": {"vendor": "Pemko", "model": "315CN", "multiplier_vendor": "PEMKO"},
    "weatherstrip": {"vendor": "National Guard Products", "model": "750S", "multiplier_vendor": "NATIONAL GUARD PRODUCTS"},
    "silencers": {"vendor": "Hager", "model": "307D", "multiplier_vendor": "HAGER"},
    "smoke_gasket": {"vendor": "National Guard Products", "model": "5050B", "multiplier_vendor": "NATIONAL GUARD PRODUCTS"},
}


def expand_hardware_set(
    set_callout: str,
    door_size: str = "3070",
    handing: str = "LH",
    fire_rating: Optional[str] = None,
    finish: str = "626",
    keyway: Optional[str] = None,
    core_type: Optional[str] = None,
) -> Dict[str, Any]:
    """Expand a hardware group into CBC's REFERENCE component list.

    This is a fallback, not an answer. Requirements 7.2: "no single standard HW list", and
    7.7: architects specify hardware by part number and series, and the spec's hardware
    schedule is the authority for what is required. Read the spec's own definition of the
    set first and quote those part numbers.

    Use this only when the plan set defines no set for the callout, or as a checklist for
    what a set of that type usually contains. The result is tagged
    `requires_estimator_confirmation` and must never be presented as what the drawings call
    for.

    No prices are returned. Look each component up in catalog-intelligence and apply the
    multiplier from lookup_vendor_multiplier.
    """
    is_exterior = "ext" in set_callout.lower() or "exit" in set_callout.lower()
    is_fire_rated = fire_rating is not None and fire_rating not in ("", "none", "0", "0 min")

    # Parse door size for kick plate / threshold sizing
    size_info = parse_door_size(door_size)
    width_in = size_info.get("width_total_in", 36) if size_info.get("parsed") else 36

    items = []

    # 1. Hinges — 3 ea
    if is_exterior:
        items.append({
            "qty": 3, "component": "Hinges (Heavy Duty NRP)",
            "vendor": "Hager", "model": "BB1191 4.5x4.5 NRP",
            "finish": "630", "catalog_lookup": "lookup_product('HAGER', 'BB1191')",
        })
    else:
        items.append({
            "qty": 3, "component": "Hinges (Standard Butt)",
            "vendor": "Hager", "model": "BB1279 4.5x4.5",
            "finish": finish, "catalog_lookup": "lookup_product('HAGER', 'BB1279')",
        })

    # 2. Lockset or Exit Device
    if is_exterior:
        items.append({
            "qty": 1, "component": "Rim Exit Device",
            "vendor": "Hager", "model": "4500 Series",
            "finish": "630", "catalog_lookup": "lookup_product('HAGER', '4500')",
        })
    else:
        items.append({
            "qty": 1, "component": "Cylindrical Lockset",
            "vendor": "Hager", "model": "3500 Series",
            "finish": finish, "catalog_lookup": "lookup_product('HAGER', '3500')",
            "keyway": keyway, "core_type": core_type,
        })

    # 3. Closer
    items.append({
        "qty": 1, "component": "Door Closer",
        "vendor": "Hager", "model": "5200 Series",
        "finish": "ALM", "catalog_lookup": "lookup_product('HAGER', '5200')",
    })

    # 4. Kick Plate — sized to door width
    kick_width = width_in - 2  # 2" less than door width (LDTW)
    items.append({
        "qty": 1, "component": f'Kick Plate 10" x {kick_width}"',
        "vendor": "Rockwood", "model": "K1050",
        "finish": "US32D", "catalog_lookup": "lookup_product('ROCKWOOD', 'K1050')",
    })

    # 5. Wall Stop
    items.append({
        "qty": 1, "component": "Wall Stop",
        "vendor": "Hager", "model": "236W",
        "finish": finish, "catalog_lookup": "lookup_product('HAGER', '236W')",
    })

    # 6. Gasketing / Threshold / Silencers
    if is_exterior:
        items.append({
            "qty": 1, "component": f'Threshold {width_in}"',
            "vendor": "National Guard Products", "model": "412S",
            "finish": "Mill ALM", "catalog_lookup": "lookup_product('NGP', '412S')",
        })
        items.append({
            "qty": 1, "component": f'Door Sweep {width_in}"',
            "vendor": "Pemko", "model": "315CN",
            "finish": "Clear ALM", "catalog_lookup": "lookup_product('PEMKO', '315CN')",
        })
        items.append({
            "qty": 1, "component": "Perimeter Weatherstrip",
            "vendor": "National Guard Products", "model": "750S",
            "finish": "Dark Bronze", "catalog_lookup": "lookup_product('NGP', '750S')",
        })
    elif is_fire_rated:
        items.append({
            "qty": 1, "component": "Smoke Gasket (Fire-Rated)",
            "vendor": "National Guard Products", "model": "5050B",
            "finish": "Brown", "catalog_lookup": "lookup_product('NGP', '5050B')",
        })
    else:
        items.append({
            "qty": 3, "component": "Rubber Frame Silencers",
            "vendor": "Hager", "model": "307D",
            "finish": "Grey", "catalog_lookup": "lookup_product('HAGER', '307D')",
        })

    # Fire rating flags
    fire_flags = []
    if is_fire_rated:
        fire_flags.append(f"Fire rating: {fire_rating}")
        fire_flags.append("All components must be UL-listed for this rating.")
        fire_flags.append("Verify door, frame, AND hardware are rated — an unrated match on a rated opening is a defect.")

    return {
        "hardware_set": set_callout,
        "door_size": door_size,
        "door_size_parsed": size_info if size_info.get("parsed") else None,
        "handing": handing,
        "fire_rating": fire_rating or "Non-Rated",
        "fire_rating_flags": fire_flags,
        "finish": finish,
        "keyway": keyway,
        "core_type": core_type,
        "components": items,
        "source": "cbc_reference_set",
        "requires_estimator_confirmation": True,
        "action_required": (
            "NOT A SPECIFICATION. This is CBC's reference set for an opening of this type. "
            "If the plan set defines this hardware group, quote the spec's part numbers "
            "instead and treat this list as a completeness check only. Confirm every "
            "component, function, finish and quantity with the estimator before pricing."
        ),
        "pricing_note": "No prices included. Look up each model via catalog-intelligence and apply the vendor multiplier from lookup_vendor_multiplier.",
    }


# ---------------------------------------------------------------------------
# 9. Lite / Louver Pricing Stub (NR-1)
# ---------------------------------------------------------------------------

def calculate_lite_louver_price(
    glazing_type: str,
    lite_size: str,
    door_size: str = "3070",
    vendor: str = "NGP",
) -> Dict[str, Any]:
    """Stub for lite/louver pricing calculator (NR-1).

    This function does NOT return prices. It returns the lookup instructions
    for the agent to use catalog-intelligence to find the correct price from
    NGP, PEMKO/Markar, or Rockwood lite/louver tables.
    """
    return {
        "glazing_type": glazing_type,
        "lite_size": lite_size,
        "door_size": door_size,
        "preferred_vendor": vendor,
        "lookup_instructions": [
            f"1. search_catalog('{vendor}', 'lite kit {lite_size}')",
            f"2. search_catalog('{vendor}', 'louver {lite_size}')",
            f"3. get_page on matched pages to read size x price matrix",
            f"4. Match glazing type '{glazing_type}' to the correct row",
            "5. Apply vendor multiplier from lookup_vendor_multiplier",
        ],
        "supported_vendors": ["NGP", "PEMKO", "Rockwood"],
        "data_source": "NR-1 & NR-8: Lite-kit table logic from NGP/PEMKO/Rockwood sheets",
    }


# ---------------------------------------------------------------------------
# 10. Proposal Formatter (Phase 6)
# ---------------------------------------------------------------------------

# Standard CBC commercial terms (static — referenced, not computed)
CBC_COMMERCIAL_TERMS = [
    "Supply-Only (Material Only, F.O.B. Factory / CBC Warehouse). Installation by others.",
    "Subject to CBC / Hamilton Parker credit approval. Hamilton Parker PO required.",
    "Quote valid for 30 days from date of quote.",
    "Freight: Carried TBD / Excluded at estimate stage (billed at actual cost).",
]


def format_cbc_proposal(
    project_name: str,
    door_lines: List[Dict[str, Any]],
    accessories_lines: List[Dict[str, Any]],
    frp_lines: Optional[List[Dict[str, Any]]] = None,
    alternates_lines: Optional[List[Dict[str, Any]]] = None,
    state: str = "OH",
    sales_tax_rate: Optional[float] = None,
) -> Dict[str, Any]:
    """Format Phase 6 CBC draft proposal.

    Every line is audited before it is totalled: a line with no `cost_source`, or one that
    was never verified against its catalog, is reported in `audit_failures` and the whole
    package is held as NOT READY. The "every line carries an audit citation" rule is
    enforced here because this is the last point before a number reaches a person.
    """
    # Tax rule: Ohio ~8%, Kentucky 6.5%, all others = 0%
    state_norm = state.strip().upper()
    if sales_tax_rate is None:
        if state_norm in ("OH", "OHIO"):
            sales_tax_rate = 0.080
        elif state_norm in ("KY", "KENTUCKY"):
            sales_tax_rate = 0.065
        else:
            sales_tax_rate = 0.000

    # --- Audit gate -------------------------------------------------------
    audit_failures = []
    for block, lines in (("doors", door_lines),
                         ("accessories", accessories_lines),
                         ("frp", frp_lines or [])):
        for i, line in enumerate(lines):
            label = line.get("tag") or line.get("description") or f"{block}[{i}]"
            src = line.get("cost_source", "")
            if not src or src == "not_specified":
                audit_failures.append({
                    "line": label, "block": block, "problem": "no cost_source",
                    "fix": "Record which sourcing path produced this cost "
                           f"({', '.join(s for s in COST_SOURCES if s != 'not_specified')}).",
                })
            elif src not in COST_SOURCES:
                audit_failures.append({
                    "line": label, "block": block,
                    "problem": f"unknown cost_source {src!r}",
                    "fix": f"Must be one of: {', '.join(COST_SOURCES)}",
                })
            if not line.get("cost_source_detail"):
                audit_failures.append({
                    "line": label, "block": block, "problem": "no cost_source_detail",
                    "fix": "Cite the price book page and multiplier, the P21 PO, or the "
                           "vendor quote reference.",
                })

    doors_sale = round(sum(l.get("ext_sale", 0.0) for l in door_lines), 2)
    doors_cost = round(sum(l.get("ext_cost", 0.0) for l in door_lines), 2)
    acc_sale = round(sum(l.get("ext_sale", 0.0) for l in accessories_lines), 2)
    acc_cost = round(sum(l.get("ext_cost", 0.0) for l in accessories_lines), 2)
    frp_sale = round(sum(l.get("ext_sale", 0.0) for l in (frp_lines or [])), 2)
    frp_cost = round(sum(l.get("ext_cost", 0.0) for l in (frp_lines or [])), 2)

    base_sale = round(doors_sale + acc_sale + frp_sale, 2)
    base_cost = round(doors_cost + acc_cost + frp_cost, 2)
    tax = round(base_sale * sales_tax_rate, 2)
    grand = round(base_sale + tax, 2)

    # Tax description
    if sales_tax_rate > 0:
        tax_note = f"Charged at {sales_tax_rate*100:.1f}% for {state_norm}."
    else:
        tax_note = "Exempt / 0% (Supply-only to GC / Out-of-state resale certificate)."

    # Alternates — priced as separate, comparable groups, never folded into the base bid.
    # Each carries its own tax so the reader can compare like with like (requirements 4.1;
    # CBC has not confirmed the reconciliation process — see `open_items` below).
    alts = []
    if alternates_lines:
        for alt in alternates_lines:
            alt_sale = round(sum(l.get("ext_sale", 0.0) for l in alt.get("lines", [])), 2)
            alt_tax = round(alt_sale * sales_tax_rate, 2)
            alts.append({
                "name": alt.get("name", "Alternate"),
                "description": alt.get("description", ""),
                "ext_sale": alt_sale,
                "sales_tax_amount": alt_tax,
                "total_with_tax": round(alt_sale + alt_tax, 2),
                # An actual delta. This carried `alt_sale` — the alternate's own total
                # under a name that reads as the difference, which is exactly the number
                # an estimator compares an alternate on.
                "net_delta_vs_base": round(alt_sale - base_sale, 2),
                "delta_basis": (
                    "alternate ext_sale minus base bid ext_sale. Assumes the alternate "
                    "REPLACES the base scope; for an add-alternate the delta is its own "
                    "ext_sale. Reconciliation is not CBC-confirmed (Open Item 11) — "
                    "state which reading you used."
                ),
            })

    ready = not audit_failures
    result = {
        "project_name": project_name,
        "state": state_norm,
        "doors_subtotal": doors_sale,
        "accessories_subtotal": acc_sale,
        "frp_subtotal": frp_sale,
        "base_bid_subtotal": base_sale,
        "base_bid_cost": base_cost,
        "freight": {
            "amount": None,
            "basis": "TBD — excluded at estimate stage",
            "note": "Freight is priced when a quote becomes a job, not at estimate "
                    "(requirements Open Item 1). Carried as a visible line so it is not "
                    "mistaken for included.",
        },
        "sales_tax_rate": sales_tax_rate,
        "sales_tax_amount": tax,
        "sales_tax_note": tax_note,
        "grand_total": grand,
        "alternates": alts,
        "terms": list(CBC_COMMERCIAL_TERMS),
        "audit_passed": ready,
        "audit_failures": audit_failures,
        "status": (
            "DRAFT — Requires estimator review and approval before sending."
            if ready else
            "NOT READY — lines are missing their cost source audit trail. "
            "Fix every entry in audit_failures before this goes to an estimator."
        ),
    }
    open_items = []
    if alts:
        open_items.append(
            "Alternates & addenda reconciliation is not a CBC-confirmed process "
            "(requirements 4.1 / FR-14 / Open Item 11). Raise it as an RFI.")
    if any(l.get("provisional") for l in (frp_lines or [])):
        open_items.append(
            "FRP quantities use unconfirmed conversion constants (Open Item 5). "
            "Estimator must confirm before pricing.")
    if open_items:
        result["open_items"] = open_items
    return result


# ---------------------------------------------------------------------------
# 11. Auto Model Router (Inflight Dynamic Model Tiering)
# ---------------------------------------------------------------------------

# Effort tiers, not model names. Model selection in Antigravity belongs to the user, in
# the model picker — nothing here can switch it, and naming specific model IDs only dated
# this file. What this routes is how much work a step is allowed to cost.
EFFORT_TIERS = {
    "routine": {
        "name": "Routine — tool call, structured output, no deliberation",
        "relative_cost": "1x (lowest)",
        "intended_workloads": [
            "Quote math, margin bands, multiplier lookups",
            "Finish translation and frame throat derivation",
            "FRP arithmetic from measured geometry",
            "Single-sheet read_schedule / read_layout",
            "Phase 0 intake and triage",
        ],
    },
    "deliberate": {
        "name": "Deliberate — read several sources and reconcile them",
        "relative_cost": "5x - 10x",
        "intended_workloads": [
            "cross_reference across sheets",
            "Spec vs schedule conflict arbitration",
            "Fire-rated opening compliance",
            "Reconciling a spec's hardware set against CBC stock lines",
            "Proposal assembly and RFI registration",
        ],
    },
    "visual": {
        "name": "Visual — render and read pixels; the expensive one",
        "relative_cost": "8x - 15x",
        "intended_workloads": [
            "Sheets with vision_need 'identity' (title block outlined)",
            "Sheets with vision_need 'full' (no text layer at all)",
            "Enlarged restroom elevation takeoffs",
            "Hand-sketched addenda or partition details",
        ],
    },
}


def route_model_for_task(
    task_type: str,
    vision_need: Optional[str] = None,
    has_conflicts: bool = False,
    is_fire_rated_or_complex: bool = False,
    opening_count: int = 1,
) -> Dict[str, Any]:
    """Deterministically classify how much effort an estimating step is allowed to cost.

    This does NOT change the model — that is the user's choice in Antigravity's model
    picker. It answers "is this a tool call, a reconciliation, or a vision pass?", so the
    expensive passes are spent deliberately rather than by habit.
    """
    task_lower = task_type.strip().lower()
    vision_norm = (vision_need or "none").strip().lower()

    # Rule 1: no text layer means pixels are the only option.
    if vision_norm in ("identity", "full") or "vision" in task_lower or "render_sheet" in task_lower:
        tier_key = "visual"
        rationale = (
            f"The sheet cannot be read as text (vision_need: '{vision_norm}'). "
            "Rendering tiles is the only way to get at it."
        )
        saving_tip = (
            "Tile at 3x2 with render_sheet and call record_vision_reading per tile as you "
            "go. Once recorded the sheet is searchable and every later question about it "
            "drops back to routine."
        )

    # Rule 2: several sources that have to be reconciled against each other.
    elif (
        has_conflicts
        or is_fire_rated_or_complex
        or "conflict" in task_lower
        or "cross_reference" in task_lower
        or "arbitration" in task_lower
        or "code_compliance" in task_lower
        or (opening_count > 30 and "hardware_expansion" in task_lower)
    ):
        tier_key = "deliberate"
        rationale = (
            "The step spans several documents, or a spec and a schedule disagree, or a "
            "fire-rated opening has to be checked component by component. That needs "
            "reading and reconciling, not a single lookup."
        )
        saving_tip = (
            "Collect every claim first and make one verify_facts call per document. "
            "Report a conflict as a conflict rather than resolving it silently."
        )

    # Rule 3: everything else is a tool call.
    else:
        tier_key = "routine"
        rationale = (
            f"'{task_type}' is deterministic and single-document. It is a tool call, not "
            "a judgement."
        )
        saving_tip = (
            "Do not reason about arithmetic — calculate_quote_line, get_margin_band and "
            "lookup_vendor_multiplier are both faster and more accurate than working it out."
        )

    tier_info = EFFORT_TIERS[tier_key]

    return {
        "task_type": task_type,
        "recommended_tier": tier_key,
        "tier_name": tier_info["name"],
        "relative_cost": tier_info["relative_cost"],
        "rationale": rationale,
        "token_saving_guidance": saving_tip,
        "note": "Effort guidance only. Model selection is the user's, in Antigravity's "
                "model picker; this tool cannot and does not switch models.",
    }


# ---------------------------------------------------------------------------
# 11. Isolated Agent Sandbox Execution
# ---------------------------------------------------------------------------


def _find_sandbox_runner() -> Optional[Path]:
    """Locate sandbox/runner.py.

    CBC_WORKSPACE_ROOT (set in mcp_config.json) first; walking the parent chain is only a
    fallback. The old five-chained-.parent version resolved correctly from exactly one
    checkout location and silently pointed outside the workspace from any other.
    """
    env_root = os.environ.get("CBC_WORKSPACE_ROOT")
    candidates = []
    if env_root:
        candidates.append(Path(env_root))
    candidates.append(Path.cwd())
    candidates.extend(Path(__file__).resolve().parents)
    for base in candidates:
        runner = base / "sandbox" / "runner.py"
        if runner.is_file():
            return runner
    return None


def execute_sandbox_script(
    script_name: str,
    code_content: Optional[str] = None,
    args: Optional[List[str]] = None,
    timeout_seconds: int = 30,
) -> Dict[str, Any]:
    """Execute an agent-written Python script safely in the isolated sandbox workspace."""
    sandbox_runner = _find_sandbox_runner()
    if sandbox_runner is None:
        return {
            "success": False,
            "error": "Sandbox runner not found. Set CBC_WORKSPACE_ROOT to the workspace "
                     "root (the directory containing sandbox/), or run the server from it.",
            "exit_code": 1,
            "stdout": "",
            "stderr": "FileNotFoundError: sandbox/runner.py",
            "created_files": [],
        }

    import importlib.util
    spec = importlib.util.spec_from_file_location("sandbox_runner", str(sandbox_runner))
    if spec and spec.loader:
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.run_sandbox_script(
            script_name=script_name,
            code_content=code_content,
            args=args,
            timeout_seconds=timeout_seconds,
        )
    return {
        "success": False,
        "error": "Failed to load sandbox runner module.",
        "exit_code": 1,
        "stdout": "",
        "stderr": "ImportError",
        "created_files": [],
    }


