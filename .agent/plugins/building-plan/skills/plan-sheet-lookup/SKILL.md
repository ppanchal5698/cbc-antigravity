---
name: plan-sheet-lookup
description: >-
  Use this skill to answer a specific question about a building plan set that has
  already been indexed — door and window schedules, hardware groups, equipment
  and fixture counts, wall types, finishes, ceiling heights, roof details, code
  notes, "which sheet shows X", "what size/model is the Y", or any request to
  list a division or trade scope. Produces answers where every stated fact has
  been verified against the document.
---

# Plan sheet lookup

Answering a targeted question with **verified** facts. Go cheap to expensive:
locate, read structured, cross-check, verify, then answer.

## 1. Route by discipline

| Question is about | Discipline | Typical sheets |
|---|---|---|
| Layout, rooms, dimensions | Architectural | `A2.x` floor plans |
| Doors, windows, hardware, partitions, finishes | Architectural | `A2.2` and schedule sheets |
| Ceilings, soffits, lighting layout | Architectural | `A3.x` reflected ceiling |
| Roof, drains, slopes, curbs | Architectural | `A4.x` |
| Elevations, exterior materials, signage | Architectural | `A6.x` |
| Sections, wall assemblies | Architectural | `A7.x` |
| Equipment, IT, fire/life safety | Architectural | `A1.x` equipment plan & schedules |
| Product specifications (all trades) | General | `G1.x` specifications |
| Code, occupancy, accessibility | General | `G0.x`, `G1.0` |
| Footings, framing, loads | Structural | `S2.x` |
| Panels, circuits, fixtures | Electrical | `E2.x` |
| HVAC units, ducts | Mechanical | `M1.x` |
| Fixtures, waste, vent, supply | Plumbing | `P2.x`, `P3.x` |
| Site, grading, utilities, parking | Civil / Site | `C1xx`, `SP1.x` |

`list_sheets(doc_id, discipline=...)` narrows the field. Numbering is
conventional, not guaranteed — confirm against the sheet title.

**Most questions have two homes:** the specification (G-series, what the product
must be) and the schedule (a drawing, what is actually installed here). Check
both. That is where conflicts live.

## 2. Locate with search

```
search_sheets(doc_id, query)
```

FTS5 syntax: quoted phrases, `AND`/`OR`/`NOT`, `prefix*`. Search the term a
draftsperson would type, not the user's phrasing — `"ROOF DRAIN"` not "how does
water get off the roof". Try several vocabulary variants before concluding
something is absent.

Watch for misspellings in the drawings themselves — this set writes
`VON DURPIN` for Von Duprin. If a term you expect returns nothing, try a partial
(`DURPIN`, `DUPR*`) before concluding it is not there.

## 3. Read structured, not flat

```
read_schedule(doc_id, sheet)      # ANY table — this is the one that matters
read_layout(doc_id, sheet)        # notes, legends, unruled tables
get_sheet(doc_id, sheet)          # title block + overview only
```

`read_schedule` returns real rows. **Count them and report every one.**
Numbering skips — `01, 02, 03, 06` is four items, and `06` is exactly the row a
careless reader drops.

If a row references something (a hardware group, a detail, a keynote), go find
that definition. If it is not defined anywhere in the set, say so — a call-out
with no definition is a genuine finding.

## 4. Cross-check every product

```
cross_reference(doc_id, "KAWNEER")
```

Run this on every manufacturer, model, series and finish before reporting it.
It returns every mention across the whole set, grouped by sheet, so a spec
saying one thing and a drawing note saying another become visible side by side.

Report conflicts as conflicts. Do not resolve them silently.

## 5. Look, only for geometry

Text has no spatial meaning. When the question is about *where* something is,
how big, or how parts connect:

```
render_sheet(doc_id, sheet)                       # 3x2 grid, locate it
render_sheet(doc_id, sheet, region="18,6,30,16")  # zoom, inches from top-left
```

Anything read this way is labelled **[drawing]**, not [schedule]. Note that many
window and storefront schedules are *dimensioned elevations*, not tables — the
numbers exist but pairing them to a specific opening requires looking. Do not
present an inferred pairing as extracted data.

Worth keeping? `record_vision_reading` saves it for next time.

## 6. Verify, then answer

Before writing the response, collect every factual claim and check it in one
call:

```
verify_facts(doc_id, ["VON DURPIN 99EO, 26", "ULINE H-6735AGR", ...])
```

Any `verified: false` is **not in this document**. Remove it or correct it to
the document's wording using `near_miss`. Never reinstate it from memory.

Then answer, citing sheet number and title, with each fact tagged
`[schedule]` / `[spec]` / `[note]` / `[drawing]` / `[not stated]`.

Close with what you could not confirm. A short answer that is entirely correct
beats a comprehensive one that is 85% correct — on construction documents the
15% is what costs money.
