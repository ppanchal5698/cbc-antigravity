---
name: vendor-catalog-intake
description: >-
  Use this skill when the user points at vendor price books or the catalogs/
  folder and wants them indexed, summarized, or made searchable — "index the
  catalogs", "what do we have price books for", "load ASI and Bobrick", "which
  vendor carries X", "what does this catalog cover" — or when any catalog,
  pricing, or product-availability question is asked before the shelf has been
  indexed. Establishes which vendor covers which CSI division, and how far each
  book can actually be trusted, before anything is priced.
---

# Vendor catalog intake

Turns the price books in `catalogs/` into a searchable, CSI-tagged, per-vendor
product index — and establishes each book's **scope and coverage** before
anyone prices anything from it.

## 1. See what is already indexed

```
list_catalogs()
```

Start here, always. It returns every indexed book with its vendor, effective
date, CSI sections, model counts, `multiplier_in_filename`, and `coverage`.
The index is shared and cached, so on a warm workspace this is the whole intake.

Anything in `catalogs/` that is **not** in that list has never been opened —
its absence proves nothing. Index it:

```
open_catalog(pdf_path)     # one call per PDF, cached by mtime + size
```

`catalogs/` is one folder per vendor and the folder name becomes the vendor on
every product returned. The server reads **PDF only** — the spreadsheets and
`.msg` files on the shelf are invisible to it, and World Dryer's real price list
is one of them.

## 2. Report coverage, not just contents

`coverage` is the field that decides how the rest of the session behaves:

| coverage | Means | Use |
|---|---|---|
| `structured` | product rows parsed across the book | `list_division`, `match_materials` are authoritative |
| `partial` | some pages parsed, some not | rows are real; **absences are unknown** |
| `text_only` | **no product rows at all** | `search_catalog` + `get_page` only |

A `text_only` book is not empty and not broken — it is priced by a finish matrix
(Rockwood Architectural), by the foot as a formula (NGP Price List), or is a
product catalog with no prices (NGP Threshold Catalog). Its text is fully
searchable. **Never report a product as unavailable because a `text_only`
catalog returned nothing.**

Tell the user, in this order:

1. **Vendors and effective dates.** A quote from a superseded book is wrong.
   Note that Bobrick and Gamco are 2020 and Rockwood Glass is 2022.
2. **Which vendor covers which division** — from the CSI sections in
   `list_catalogs`. On this shelf: ASI / Bobrick / Bradley cover Division 10 28
   washroom accessories; Hager covers Division 08 71 door hardware; Pemko and
   NGP cover thresholds and weatherstripping; Rockwood covers pulls, plates and
   glass hardware.
3. **What nobody covers.** Toilet partitions (10 21 13), lockers (10 51 00) and
   fire extinguisher cabinets (10 44 00) are not on this shelf. Say it during
   intake, not after a takeoff has been built.
4. **Which books are `partial` or `text_only`**, and that questions landing
   there need `get_page`.

## 3. Spot-check before trusting a book

Two cheap checks per newly indexed catalog:

```
list_division(catalog_id, "10")            # or the division it claims to cover
lookup_product(catalog_id, <a model from that list>)
```

For a book whose products have sizes and finishes (Hager), `lookup_product`
should return several rows for one model with different prices. For a flat
line-item book (ASI, Bobrick, Bradley) one row per model with an empty size and
finish is correct — the size is inside the description, so it must be read from
there rather than assumed.

If a model comes back with a price you cannot see on the page, read the page
with `get_page` before using it.

## 4. State the price basis once, up front

Most books here quote **list**. Bobrick's columns are headed *Net Cost Each*.
Say which applies to which vendor now, so it does not have to be caveated on
every line later — and still label totals with their basis.

`multiplier_in_filename` (ASI `.375`, NGP `.45`, Rockwood Accessories `.55`,
World Dryer `.339`) was read off a **file name, not a document**. Treat it as a
hint and confirm it against the vendor's own multiplier sheet —
`HAGER/Hager Multipliers and Special Nets`, `BOBRICK/Multiplier.docx` — before
applying it to anything. Bradley's `.53` is in its filename but is not
auto-detected.

## Notes

- All catalogs share one database keyed by path + mtime + size. Nothing needs
  closing or clearing between them, and re-opening an unchanged file is instant.
- `list_division` and `match_materials` accept `catalog_id=""` to search the
  whole shelf and report which vendor carries what. Prefer that to looping.
- `search_catalog` covers **every** page of a catalog including its unparsed
  sections — reach for it whenever `list_division` comes up short.
- Item numbers (`order_item_numbers` on `lookup_product`) are the vendor's SKUs;
  include them when the user is ordering rather than estimating.
