---
name: frp-takeoff
description: Division 06 FRP wall panel and vinyl moulding takeoff from room geometry, priced against NUDO. Phase 3b.
---

# FRP takeoff (Division 06 64 00)

CBC measures FRP in Vu360 and converts to quantities with a calculator (requirements
Phase 3b). This does the conversion; the geometry still comes from the drawings.

## 1. Get the geometry

Rooms that take FRP: kitchens, food prep, washdown areas, restrooms, janitor closets. Find
them in the room finish schedule or on the enlarged plans, then capture:

- **perimeter linear feet** — the run of wall being panelled
- **wall height** — full height, or a wainscot (4'-0" is common)
- **inside corner count** and **outside corner count**

`read_schedule` for the finish schedule; `read_layout` for keynotes; `render_sheet` with a
`region` when a dimension is only readable off the drawing. Anything measured by eye is
`[drawing]` and less certain than a scheduled dimension — say which.

## 2. Convert

```
calculate_frp_takeoff(perimeter_lf, inside_corners, outside_corners, wall_height_ft)
```

Sheets are 4'x8' up to an 8-ft wall and 4'x10' above it, `.090"` Class C white embossed.
The tool returns sheet count, division bars, corner mouldings, end caps, adhesive pails and
rivets.

> **The conversion constants are not CBC's.** Waste percentage, adhesive coverage, rivets per
> sheet and trim stick length are working assumptions — CBC Open Item 5 is still *"conversion
> constants still to be provided"*. Every result comes back `provisional: true` with an
> `action_required`. Carry that flag onto every FRP line and have the estimator confirm the
> quantities before they are priced. Do not quietly present them as CBC's numbers.

## 3. Price against NUDO

NUDO's sheets are **`text_only`** — invisible to `list_division` and `match_materials`
however much NUDO sells. Use:

```
search_catalog(nudo_catalog_id, "FRP")      # or "moulding", "division bar", "J trim"
get_page(nudo_catalog_id, page)             # read the prices off text_rows yourself
```

Tag anything read this way `[catalog-page]` — less certain than a parsed price row, and say
so. Sheets price per sheet, mouldings per stick.

Then `get_margin_band("commodity")` (27%) and `calculate_quote_line(..., cost_source="catalog_list_x_multiplier",
cost_source_detail="NUDO Midwest/East Coast FRP 5-11-26 p<n>")`.

## 4. Verify and report

```
verify_facts(doc_id,     [ room names, perimeter dimensions ])
verify_facts(catalog_id, [ sheet and moulding prices ])
```

Output the material list — sheets, each trim type, adhesive, rivets — with the subtotal, the
provisional-constants flag, and which dimensions were read off a drawing rather than a
schedule.
