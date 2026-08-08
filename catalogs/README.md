# catalogs/

Vendor price books, one folder per vendor. `catalog-intelligence` indexes the
PDFs; the folder name becomes the vendor on every product it returns.

## The shelf

Indexed 2026-08-06. **Coverage** is what the agent must route on:

- **structured** — product rows parsed across the book; `list_division` and
  `match_materials` work
- **partial** — some pages parsed, the rest need `get_page`
- **text_only** — **no product rows at all**; the book is searchable but
  invisible to `list_division` / `match_materials`

| Vendor | File | pp | Coverage | Price rows | CSI |
|---|---|---|---|---|---|
| **ASI** | ASI-Price-List - 1-12-26 - .375 Multiplier | 62 | structured | 1,427 | 10 28 00 · 10 28 13 |
| **BOBRICK** | BOBRICK 2020 PRICE LIST | 29 | structured | 453 | 10 28 00 · 08 71 00 |
| **BOBRICK** | Gamco_Price_List_2020 | 12 | structured | 313 | 10 28 00 · 10 28 13 |
| **BRADLEY** | 26 price book WAD .53 | 44 | structured | 705 | 10 28 00 · 10 28 13 |
| **HAGER** | Hager Price Book #18 - Effective 2-2-26 | 744 | structured | 9,122 | 08 71 00 · 08 71 13 · 10 14 00 · 10 26 00 · 10 28 00 |
| **HAGER** | Hager Multipliers and Special Nets | 4 | text_only | — | multiplier sheet, not a price book |
| **PEMKO** | markar_and_pemko_price_book_2026 | 84 | structured | 711 | 08 71 00 |
| **PEMKO** | Buying Program Account 4244636 | 1 | text_only | — | one-page program sheet |
| **ROCKWOOD** | 7.29.22 Glass Solutions Price Book | 44 | structured | 139 | 08 71 00 |
| **ROCKWOOD** | Rockwood Accessories - .55 Multiplier | 44 | partial | 22 | 08 71 00 |
| **ROCKWOOD** | Rockwood Architectural - 3-3-25 | 88 | partial | 7 | 08 71 00 |
| **ROCKWOOD** | Rockwood LitesLouvers - 02.27.23 | 8 | text_only | — | |
| **NATIONAL GUARD PRODUCTS** | NGP Price List 6-8-2026 - .45 Multiplier | 88 | partial | 15 | |
| **NATIONAL GUARD PRODUCTS** | NGP Threshold Catalog | 56 | text_only | — | product data, no prices |
| **NUDO** | MIDWEST-EAST COAST FRP 5-11-26 | 1 | text_only | — | |
| **NUDO** | VINYL MOLDINGS PRICING 5-11-26 | 5 | text_only | — | |
| **WORLD DRYER** | L3-Pricing Change Memo Sept 2022 | 1 | text_only | — | memo; the price list is .xlsx |

Run `list_catalogs` for the live version of this table — it is generated from
the index, this one is a snapshot.

## Which vendor for which division

| Need | Go to |
|---|---|
| **Division 10 28 00** washroom accessories — dispensers, grab bars, mirrors, baby changing, hand dryers | **ASI**, **BOBRICK** (+Gamco), **BRADLEY** |
| **Division 08 71 00** door hardware — hinges, locks, closers, exit devices, trim | **HAGER** |
| **Division 08 71 00** thresholds, weatherstripping, gasketing | **PEMKO**, **NATIONAL GUARD PRODUCTS** |
| **Division 08 71 00** pulls, push plates, protection plates, glass door hardware | **ROCKWOOD** |
| **Division 08 91 00** louvers, vision lites | **ROCKWOOD** (LitesLouvers — text_only) |
| **Division 06 64 00** FRP wall panels, vinyl mouldings | **NUDO** (text_only) |
| Hand dryers | **WORLD DRYER** (text_only) and **ASI** |
| **Division 10 21 13** toilet partitions | **not on this shelf** — no indexed vendor carries them |

## Why some catalogs are text_only

They are not broken; they are laid out differently and are still fully
searchable with `search_catalog` and `get_page`:

- **Rockwood Architectural / Accessories** price by a finish matrix — model down
  the side, finish codes across the top (`3/605`, `10B/613`, `32D/630`), prices
  as bare integers with no decimal point.
- **NGP Price List** prices thresholds by the foot as formulas
  (*"multiply width (inches) × $14.20 / FT."*), not as fixed line items.
- **NGP Threshold Catalog** carries dimensions and weights, no prices at all.
- **NUDO**, **World Dryer**, **Pemko Buying Program** are one- to five-page
  sheets and memos.

Never read a text_only catalog's silence as "this vendor does not carry it."

## Non-PDF files

`catalog-intelligence` reads **PDF only**. These are on the shelf but not
indexed, and must be opened by hand:

- `BOBRICK/GAM-PL 2020 PRICE LIST.xlsx`, `Gamco Cross over (2).xls`,
  `Shandas Cross Reference.xlsx`, `Multiplier.docx`,
  `Hamilton Parker 2017 Program Price Sheet Bobrick NET.xlsx`, `… Gamco.xlsx`
- `WORLD DRYER/Copy of L-3World Dryer Pricing_9.2022_L3 - .339 MULTIPLIER.xlsx`
  — **this is World Dryer's actual price list**; the indexed PDF is only a memo
- `NUDO/FW Pricing Sheets - NUDO - PRICE INCREASE.msg`
- `CBC_Req_Validation_v1_3.xlsx`

## Multipliers

Every price in the index is a **list** price unless the book itself says
otherwise (Bobrick's columns are headed *Net Cost Each*).

Five filenames carry the multiplier, and `open_catalog` reports it as
`multiplier_in_filename`: ASI `.375`, NGP `.45`, Rockwood Accessories `.55`,
World Dryer `.339`, Bradley `.53` (in the filename as `WAD .53`, without the
word "multiplier", so it is not auto-detected).

That value came from a **file name, not a document**. Confirm it against the
vendor's own multiplier sheet — `HAGER/Hager Multipliers and Special Nets` for
Hager, `BOBRICK/Multiplier.docx` for Bobrick — before applying it, and say so
whenever a net number is quoted.
