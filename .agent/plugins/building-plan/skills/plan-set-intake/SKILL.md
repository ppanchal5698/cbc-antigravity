---
name: plan-set-intake
description: >-
  Use this skill when the user points at a new building plan set PDF and wants it
  indexed, summarized, or made searchable — "what's in this plan set", "index
  these drawings", "summarize this bid set", or when any other plan question is
  asked about a PDF that has not been opened yet. Walks the full intake:
  indexing, triage, and the vision pass over sheets that have no text layer.
---

# Plan set intake

Turns a plan set PDF into a fully searchable index, including the sheets that
only a vision model can read.

## 1. Index

```
open_plan_set(pdf_path)
```

Returns a `doc_id` plus page count, sheet size, disciplines, and a `vision_need`
breakdown. Cached by file mtime and size — re-running on an unchanged file is
instant, so never avoid calling it.

Then:

```
plan_overview(doc_id)
```

This gives disciplines with page ranges and the exact page lists needing vision.

## 2. Report before you spend anything

Tell the user what the set contains — disciplines, sheet counts, page ranges —
and how many sheets need a vision pass, **before** starting one. On a large set
that pass is the expensive part, and the user may only care about one
discipline. Ask which sheets matter if the set is big and their question is
narrow.

## 3. Vision pass, only where needed

For each page in `needs_vision_full` (no text at all) and
`needs_vision_identity` (title block outlined, so the sheet is unnamed):

1. `render_sheet(doc_id, sheet=<page>)` — returns the 3x2 tile grid.
2. Read the tiles yourself. Work tile by tile; do not skim.
3. `record_vision_reading(doc_id, sheet=<page>, text=..., tile=<tile>)`

What to capture in the text you record, roughly in priority order:

- the sheet number and sheet title (write `sheet_no=A2.0` so the server can fill
  in a missing identity)
- drawing titles and their detail/callout numbers
- schedules, keynotes, and general notes — verbatim where short
- dimensions and material callouts
- anything a later search would plausibly look for

Record per tile as you go rather than batching at the end. If you stop halfway,
the work already done is saved.

## 3a. Capture the schedules

Schedules are where most questions get answered, so index them while you are
here. For each sheet whose `get_sheet` reports `tables_on_sheet > 0` — schedule
sheets, equipment plans, spec sheets — run `read_schedule` and note what tables
it holds (door, window, hardware, equipment, finish, panel).

Report the row tags exactly as they appear, including gaps: a door schedule of
`01, 02, 03, 06` has four doors. Flag any row that references a definition the
set never provides.

## 4. Confirm the loop closed

Re-run `plan_overview(doc_id)`. Pages you recorded should have dropped off the
needs-vision lists. Spot-check with `search_sheets` for a term that only appears
on a sheet you just read — if it comes back with `found_in: vision`, the pass
worked.

## Notes

- A sheet with `vision_need: identity` still has searchable body text. If the
  user only needs content, not the sheet label, you can skip it.
- `list_sheets(doc_id, vision_need="full")` gives the worklist directly.
- Sheet size other than 36x24 — adjust `cols`/`rows` on `render_sheet` to keep
  roughly 12 inches of drawing per tile.
