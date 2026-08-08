"""OKF knowledge graph — CBC's institutional estimating memory.

Holds what past jobs and estimator corrections taught the copilot: which hardware sets a
brand actually uses, which wall description maps to which throat, which substitutions an
estimator has already approved.

DESIGN RULE, same as engine.py: **no prices live here.** A price in the graph is a price
nobody re-verified against a current price book, and it would reach a quote line looking
exactly like a verified one. CatalogProduct nodes carry identity and pricing basis so the
graph can say *which* product; catalog-intelligence says what it costs, at the moment of
quoting.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Required fields per class, from knowledge_graph/schema.json. Validated on load so a
# malformed node is reported rather than silently returning None from a .get().
REQUIRED_FIELDS = {
    "BrandAccount": ("id", "name"),
    "HardwareSetTemplate": ("id", "name", "category"),
    "CatalogProduct": ("id", "vendor", "model", "category"),
    "WallTypeMapping": ("id", "wall_description", "recommended_throat"),
    "VendorEquivalence": ("id", "specified_model", "proposed_vendor", "proposed_model"),
    "EstimatorCorrectionPattern": ("id", "trigger_context", "override_value"),
    "UncarriedDivisionPattern": ("id", "csi_division", "status"),
}

# Fields a CatalogProduct node must never carry. See the module docstring.
FORBIDDEN_PRODUCT_FIELDS = ("list_price", "net_cost", "price", "cost")

# Apostrophes are dropped, not replaced: "Wendy's" is `wendys`, not `wendy_s`.
_ID_DROP = re.compile(r"['’.]")
_ID_PUNCT = re.compile(r"[^a-z0-9]+")


def _norm_id(value: str) -> str:
    """Normalize a brand or set name into an id fragment.

    One function, used by every read and every write. The two call sites used to normalize
    differently -- `lower()` on write, `lower().replace("'","").replace(" ","_")` on read --
    so "Wendy's" reinforced `brand:wendy's` and was then read back from `brand:wendys`, and
    no learning ever landed.
    """
    cleaned = _ID_DROP.sub("", (value or "").strip().lower())
    return _ID_PUNCT.sub("_", cleaned).strip("_")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_graph_path() -> Path:
    root = os.environ.get("CBC_WORKSPACE_ROOT")
    if root:
        candidate = Path(root) / "memory" / "knowledge_graph" / "graph.json"
        if candidate.exists():
            return candidate
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "memory" / "knowledge_graph" / "graph.json"
        if candidate.exists():
            return candidate
    return Path("memory/knowledge_graph/graph.json")


class OKFKnowledgeGraph:
    """Ontology traversal, semantic resolution, and reinforcement learning over graph.json."""

    def __init__(self, graph_path: Optional[Path] = None):
        self.graph_path = Path(graph_path) if graph_path else _default_graph_path()
        self.metadata: Dict[str, Any] = {}
        self.nodes: Dict[str, Dict[str, Any]] = {}
        self.outgoing_edges: Dict[str, List[Dict[str, Any]]] = {}
        self.incoming_edges: Dict[str, List[Dict[str, Any]]] = {}
        self.validation_errors: List[str] = []
        self.load()

    # ------------------------------------------------------------------
    # Load / save
    # ------------------------------------------------------------------
    def load(self) -> None:
        self.nodes = {}
        self.outgoing_edges = {}
        self.incoming_edges = {}
        self.validation_errors = []

        if not self.graph_path.exists():
            self._init_empty_graph()
            return

        with open(self.graph_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.metadata = data.get("metadata", {})
        for node in data.get("nodes", []):
            self._index_node(node)
        for edge in data.get("edges", []):
            self._index_edge(edge)
        self.validation_errors = self.validate()

    def _index_node(self, node: Dict[str, Any]) -> None:
        """Store by id. `nodes` is the only node store, so re-ingesting cannot duplicate.

        The old implementation kept a parallel `nodes_by_class` list and appended to it
        unconditionally -- learning the same correction twice left two copies in every
        class listing while the dict held one.
        """
        self.nodes[node["id"]] = node

    def _index_edge(self, edge: Dict[str, Any]) -> None:
        self.outgoing_edges.setdefault(edge["source"], []).append(edge)
        self.incoming_edges.setdefault(edge["target"], []).append(edge)

    def _init_empty_graph(self) -> None:
        self.metadata = {
            "title": "CBC Commercial Estimating Knowledge Graph",
            "total_nodes": 0,
            "total_edges": 0,
            "learning_cycles_completed": 0,
            "last_updated": _now(),
        }

    def validate(self) -> List[str]:
        """Required fields per class, plus the no-prices rule. Returns problems found."""
        problems = []
        for node_id, node in self.nodes.items():
            cls = node.get("class", "GenericEntity")
            for field in REQUIRED_FIELDS.get(cls, ()):
                if node.get(field) in (None, "") and field != "id":
                    problems.append(f"{node_id}: {cls} is missing required field {field!r}")
            if cls == "CatalogProduct":
                for field in FORBIDDEN_PRODUCT_FIELDS:
                    if field in node:
                        problems.append(
                            f"{node_id}: CatalogProduct carries {field!r}. The graph holds "
                            f"no prices -- look this up in catalog-intelligence instead.")
        for src, edges in self.outgoing_edges.items():
            for edge in edges:
                if src not in self.nodes:
                    problems.append(f"edge {edge.get('type')}: source {src!r} does not exist")
                if edge["target"] not in self.nodes:
                    problems.append(
                        f"edge {edge.get('type')}: target {edge['target']!r} does not exist")
        return problems

    def save(self, target_path: Optional[Path] = None) -> None:
        """Serialize back to disk, atomically."""
        path = Path(target_path) if target_path else self.graph_path
        path.parent.mkdir(parents=True, exist_ok=True)

        all_edges = [e for edges in self.outgoing_edges.values() for e in edges]
        self.metadata["total_nodes"] = len(self.nodes)
        self.metadata["total_edges"] = len(all_edges)
        self.metadata["last_updated"] = _now()

        payload = {
            "okf_version": "1.1.0",
            "metadata": self.metadata,
            "nodes": list(self.nodes.values()),
            "edges": all_edges,
        }
        temp_path = path.with_suffix(".tmp")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        temp_path.replace(path)

    # ------------------------------------------------------------------
    # Query & traversal
    # ------------------------------------------------------------------
    def get_node(self, node_id: str) -> Optional[Dict[str, Any]]:
        return self.nodes.get(node_id)

    def get_nodes_by_class(self, node_class: str) -> List[Dict[str, Any]]:
        return [n for n in self.nodes.values() if n.get("class") == node_class]

    def get_connected_nodes(
        self, node_id: str, relation_type: Optional[str] = None, direction: str = "out"
    ) -> List[Tuple[Dict[str, Any], Dict[str, Any]]]:
        """[(connected_node, edge)] in the requested direction."""
        results = []
        edges = (self.outgoing_edges if direction == "out" else self.incoming_edges).get(
            node_id, [])
        for edge in edges:
            if relation_type and edge.get("type") != relation_type:
                continue
            other = self.nodes.get(edge["target"] if direction == "out" else edge["source"])
            if other:
                results.append((other, edge))
        return results

    def get_brand_intelligence(self, brand_key: str) -> Dict[str, Any]:
        """Brand programme margins and preferred packages, or the standard commercial fallback.

        A brand whose margins CBC has not supplied (NR-9) returns the standard bands with
        `margin_status: PENDING_CBC_DATA` rather than a made-up rate.
        """
        node = self.nodes.get(f"brand:{_norm_id(brand_key)}")
        fallback = self.nodes.get("brand:standard_commercial", {})
        if not node:
            node = fallback or {"id": "brand:standard_commercial",
                                "name": "Standard Commercial",
                                "commodity_margin": 0.27, "accessories_margin": 0.56,
                                "confidence": 1.0}

        hw_sets = [
            {"set_id": n["id"], "name": n.get("name", ""),
             "weight": e.get("weight", 1), "frequency": e.get("frequency", 1)}
            for n, e in self.get_connected_nodes(node.get("id", ""), "PREFERS_HARDWARE_SET")
        ]
        preferred_throat = node.get("preferred_throat_depth")
        if not preferred_throat:
            for n, _ in self.get_connected_nodes(node.get("id", ""), "PREFERS_THROAT"):
                preferred_throat = n.get("recommended_throat")
                break

        status = node.get("margin_status", "confirmed")
        commodity = node.get("commodity_margin")
        accessories = node.get("accessories_margin")
        pending = status == "PENDING_CBC_DATA" or commodity is None

        return {
            "brand_id": node.get("id", "brand:standard_commercial"),
            "brand_name": node.get("name", "Standard Commercial"),
            "margin_status": status,
            "commodity_margin": fallback.get("commodity_margin", 0.27) if pending else commodity,
            "accessories_margin": (fallback.get("accessories_margin", 0.56)
                                   if pending else accessories),
            "margin_note": (
                node.get("margin_source", "Special margins not supplied (NR-9).") + " "
                "Standard bands applied; confirm with the estimator."
            ) if pending else node.get("margin_source", "confirmed programme margin"),
            "preferred_throat_depth": preferred_throat,
            "preferred_hardware_sets": sorted(hw_sets, key=lambda s: -s["weight"]),
            "confidence": node.get("confidence", 1.0),
        }

    def get_hardware_set_expansion(self, set_id: str) -> List[Dict[str, Any]]:
        """A set template's components. Identity only — prices come from the catalog."""
        return [
            {
                "product_id": n["id"],
                "vendor": n.get("vendor"),
                "model": n.get("model"),
                "category": n.get("category"),
                "finish": n.get("finish"),
                "quantity": e.get("quantity", 1),
                "sizing_rule": e.get("sizing_rule", "standard"),
                "pricing_basis": n.get("pricing_basis", "list"),
                "multiplier": n.get("multiplier"),
                "price_lookup": n.get("price_lookup", "catalog-intelligence"),
            }
            for n, e in self.get_connected_nodes(set_id, "CONTAINS_COMPONENT")
        ]

    def resolve_wall_to_throat(self, wall_description: str) -> Dict[str, Any]:
        """Resolve a wall description to a throat size via learned mappings, then heuristics."""
        desc = (wall_description or "").lower()
        best, best_score = None, 0.0
        for node in self.get_nodes_by_class("WallTypeMapping"):
            tokens = [t for t in re.split(r"\W+", node.get("wall_description", "").lower())
                      if len(t) > 2]
            if not tokens:
                continue
            score = sum(1 for t in tokens if t in desc) / len(tokens)
            if score > best_score:
                best, best_score = node, score

        if best and best_score >= 0.5:
            return {
                "recommended_throat": best["recommended_throat"],
                "confidence": round(best.get("confidence", 1.0) * best_score, 2),
                "source": "WallTypeMapping",
                "source_node": best["id"],
                "rule_matched": best.get("wall_description"),
            }

        if any(k in desc for k in ("cmu", "masonry", "block", "concrete")):
            return {"recommended_throat": '5-3/4"', "confidence": 0.90,
                    "source": "heuristic_masonry"}
        if any(k in desc for k in ('6"', "6 in", "6 inch")):
            return {"recommended_throat": '8-1/4"', "confidence": 0.90,
                    "source": "heuristic_6in_stud"}
        if "1/2" in desc and "drywall" in desc:
            return {"recommended_throat": '5-5/8"', "confidence": 0.90,
                    "source": "heuristic_half_inch"}
        if "wood" in desc:
            return {"recommended_throat": '7-3/4"', "confidence": 0.90,
                    "source": "heuristic_wood_stud"}
        return {"recommended_throat": '5-7/8"', "confidence": 0.85,
                "source": "heuristic_standard_default"}

    def lookup_vendor_equivalence(self, specified_model: str) -> Optional[Dict[str, Any]]:
        """A learned substitution for a specified model, if one exists."""
        target = (specified_model or "").lower().strip()
        if not target:
            return None
        # Match on the model token, not the whole phrase: a drawing writes "LCN 4040XP"
        # while the node's specified_model is "4040XP Door Closer", and neither string
        # contains the other.
        target_tokens = {t for t in re.split(r"\W+", target) if len(t) > 2}
        for node in self.get_nodes_by_class("VendorEquivalence"):
            spec = node.get("specified_model", "").lower()
            spec_tokens = {t for t in re.split(r"\W+", spec) if len(t) > 2}
            model_token = next((t for t in re.split(r"\W+", spec) if any(c.isdigit() for c in t)),
                               None)
            if spec and (spec in target or target in spec
                         or (model_token and model_token in target_tokens)
                         or (spec_tokens and spec_tokens <= target_tokens)):
                return {
                    "specified_vendor": node.get("specified_vendor"),
                    "specified_model": node.get("specified_model"),
                    "proposed_vendor": node.get("proposed_vendor"),
                    "proposed_model": node.get("proposed_model"),
                    "equivalence_tier": node.get("equivalence_tier", "direct_equal"),
                    "estimator_approved": node.get("estimator_approved", False),
                    "confidence": node.get("confidence", 0.95),
                    "note": "A substitution requires GC approval. Present the specified "
                            "product and the proposed equal side by side.",
                }
        return None

    def get_smart_recommendation(self, context_type: str, query: str) -> Dict[str, Any]:
        """Graph-grounded recommendation for one of the supported contexts."""
        if context_type == "vendor_substitution":
            equiv = self.lookup_vendor_equivalence(query)
            if equiv:
                return {"status": "found", "recommendation": equiv,
                        "source": "VendorEquivalence"}
            return {"status": "not_found",
                    "message": "No learned substitution. Search the shelf with "
                               "match_materials before proposing one."}
        if context_type == "frame_throat":
            return {"status": "resolved", "recommendation": self.resolve_wall_to_throat(query),
                    "source": "WallTypeMapping"}
        if context_type == "brand_package":
            return {"status": "resolved", "recommendation": self.get_brand_intelligence(query),
                    "source": "BrandAccount"}
        if context_type == "uncarried":
            q = query.lower()
            for node in self.get_nodes_by_class("UncarriedDivisionPattern"):
                if node["csi_division"].replace(" ", "") in q.replace(" ", "") \
                        or node.get("description", "").lower()[:12] in q:
                    return {"status": "resolved", "recommendation": node,
                            "source": "UncarriedDivisionPattern"}
            return {"status": "not_found",
                    "message": "No recorded uncarried pattern for that division."}
        return {"status": "unsupported_context",
                "message": f"Context {context_type!r} is not supported. Use one of: "
                           "vendor_substitution, frame_throat, brand_package, uncarried."}

    # ------------------------------------------------------------------
    # Learning
    # ------------------------------------------------------------------
    def _upsert_edge(self, source: str, target: str, edge_type: str,
                     **attrs: Any) -> Tuple[Dict[str, Any], bool]:
        """Find or create an edge. Returns (edge, created)."""
        for edge in self.outgoing_edges.get(source, []):
            if edge.get("target") == target and edge.get("type") == edge_type:
                return edge, False
        edge = {"source": source, "target": target, "type": edge_type, **attrs}
        self._index_edge(edge)
        return edge, True

    def learn_from_quote(self, quote_data: dict, brand: str = "") -> Dict[str, Any]:
        """Reinforce the patterns a finished quote actually used."""
        brand_id = f"brand:{_norm_id(brand)}" if brand else "brand:standard_commercial"
        if brand_id not in self.nodes:
            return {"status": "ignored",
                    "reason": f"No BrandAccount node {brand_id!r}. Create the brand before "
                              "learning from its quotes."}

        reinforcements = []
        for door in quote_data.get("door_lines", []):
            tag = door.get("hw_set") or door.get("hardware_set")
            if not tag:
                continue
            match = next(
                (nid for nid in self.nodes
                 if nid.startswith("hw_set:") and str(tag).lower() in nid.lower()), None)
            if not match:
                reinforcements.append(f"no hardware set node matches {tag!r} — not learned")
                continue
            edge, created = self._upsert_edge(
                brand_id, match, "PREFERS_HARDWARE_SET", weight=0, frequency=0)
            edge["weight"] = edge.get("weight", 0) + 1
            edge["frequency"] = edge.get("frequency", 0) + 1
            edge["last_used"] = _now()
            reinforcements.append(
                f"{'created' if created else 'reinforced'} {brand_id} -> {match} "
                f"(weight={edge['weight']})")

        self.metadata["learning_cycles_completed"] = \
            self.metadata.get("learning_cycles_completed", 0) + 1
        self.save()
        return {
            "status": "learned",
            "brand_id": brand_id,
            "cycle": self.metadata["learning_cycles_completed"],
            "reinforcements": reinforcements,
        }

    def learn_from_correction(self, correction_record: dict) -> Dict[str, Any]:
        """Ingest an estimator override from corrections.jsonl.

        Creates the EstimatorCorrectionPattern node AND the SUPERSEDES edge the rules
        promise -- the previous version created no edges at all while the documentation
        claimed it linked SUPERSEDES and SUBSTITUTED_BY.

        A VendorEquivalence is only minted when the override is genuinely a model
        substitution. A finish or quantity correction is not a substitution, and recording
        one as such taught the graph a substitution that nobody approved.
        """
        specified = (correction_record.get("specified_callout") or "").strip()
        override = (correction_record.get("estimator_override") or "").strip()
        if not specified or not override:
            return {"status": "ignored",
                    "reason": "Record needs both specified_callout and estimator_override."}

        initial = (correction_record.get("copilot_initial_match") or "").strip()
        pattern_id = f"pattern:override_{_norm_id(specified)[:30]}"
        existing = self.nodes.get(pattern_id)

        if existing:
            # Repeat application is what earns confidence. One override is evidence.
            existing["times_applied"] = existing.get("times_applied", 1) + 1
            existing["confidence_weight"] = min(
                1.0, round(existing.get("confidence_weight", 0.6) + 0.1, 2))
            existing["override_value"] = override
            existing["last_applied_timestamp"] = _now()
            pattern = existing
        else:
            pattern = {
                "id": pattern_id,
                "class": "EstimatorCorrectionPattern",
                "trigger_context": specified,
                "original_suggestion": initial,
                "override_value": override,
                "reason": correction_record.get("reason", ""),
                "division": correction_record.get("division", "08"),
                "confidence_weight": 0.6,
                "times_applied": 1,
                "last_applied_timestamp": _now(),
            }
            self._index_node(pattern)

        edges_written = []
        superseded = self._find_product(initial)
        if superseded:
            edge, created = self._upsert_edge(
                pattern_id, superseded, "SUPERSEDES", priority_weight=0)
            edge["priority_weight"] = pattern["confidence_weight"]
            edge["reason"] = pattern["reason"]
            edges_written.append(f"SUPERSEDES {superseded}" + ("" if created else " (updated)"))

        replacement = self._find_product(override)
        if superseded and replacement and superseded != replacement:
            edge, created = self._upsert_edge(
                superseded, replacement, "SUBSTITUTED_BY",
                estimator_approved=True, times_used=0)
            edge["times_used"] = edge.get("times_used", 0) + 1
            edge["confidence"] = pattern["confidence_weight"]
            edges_written.append(
                f"SUBSTITUTED_BY {superseded} -> {replacement}"
                + ("" if created else " (updated)"))

        # Only a genuine model swap becomes a VendorEquivalence.
        equiv_id = None
        if initial and _norm_id(initial) != _norm_id(override):
            equiv_id = f"equiv:{_norm_id(specified)[:30]}"
            self._index_node({
                "id": equiv_id,
                "class": "VendorEquivalence",
                "specified_vendor": correction_record.get("specified_vendor",
                                                          "per drawings"),
                "specified_model": specified,
                "proposed_vendor": correction_record.get("override_vendor",
                                                         "estimator selection"),
                "proposed_model": override,
                "equivalence_tier": "estimator_override",
                "estimator_approved": True,
                "confidence": pattern["confidence_weight"],
            })

        self.metadata["learning_cycles_completed"] = \
            self.metadata.get("learning_cycles_completed", 0) + 1
        self.save()
        return {
            "status": "learned_correction",
            "pattern_id": pattern_id,
            "equiv_id": equiv_id,
            "edges": edges_written,
            "times_applied": pattern["times_applied"],
            "confidence_weight": pattern["confidence_weight"],
            "override_saved": override,
        }

    def _find_product(self, text: str) -> Optional[str]:
        """Best CatalogProduct node id for a free-text model reference, or None."""
        needle = (text or "").lower().strip()
        if not needle:
            return None
        best, best_len = None, 0
        for node in self.get_nodes_by_class("CatalogProduct"):
            model = (node.get("model") or "").lower()
            head = model.split()[0] if model else ""
            if head and (head in needle or needle.split()[0] == head) and len(head) > best_len:
                best, best_len = node["id"], len(head)
        return best


_GRAPH: Optional[OKFKnowledgeGraph] = None


def graph(reload: bool = False) -> OKFKnowledgeGraph:
    """The shared graph, created on first use.

    Lazy rather than a module-level singleton: importing this module used to read and index
    graph.json as a side effect, in every process that touched the engine.
    """
    global _GRAPH
    if _GRAPH is None or reload:
        _GRAPH = OKFKnowledgeGraph()
    return _GRAPH
