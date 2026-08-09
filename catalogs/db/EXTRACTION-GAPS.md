# Extraction gaps

Pages whose printed product rows were never extracted into a table.
The rows are present in `text_line` / `word` (the text layer of every PDF
was verified byte-identical to the source), but no query can reach them.
Counted only lines that start with a part-number-like token and carry a
price; narrative terms-and-conditions amounts are excluded.

| database | source | rows missed | pages | page numbers |
| --- | --- | ---: | ---: | --- |
| `markar_pemko_price_book_2026.sqlite` | PEMKO/markar_and_pemko_price_book_2026.pdf | 1463 | 42 | 6, 30-36, 44, 46-47, 49-51, 55-82 |
| `hager_price_book_18.sqlite` | HAGER/Hager Price Book #18 - Complete - Effective 2-2-26.pdf | 987 | 67 | 12-13, 15, 163-167, 212, 216, 253, 279, 282, 286, 289, 293-295, 298, 303, 306, 310-313, 315-317, 411-412, 458-461, 488, 490-492, 494-497, 500, 515-516, 518-537, 580, 582 |
| `rockwood_accessories_2022.sqlite` | ROCKWOOD/Rockwood Accessories Price Book - .55 Multiplier.pdf | 128 | 10 | 23, 25, 28-30, 33-35, 40-41 |
| `bradley_price_book_2026.sqlite` | BRADLEY/26 price book WAD .53.pdf | 86 | 4 | 22, 27, 33-34 |
| `bobrick_price_list_2020.sqlite` | BOBRICK/BOBRICK 2020 PRICE LIST.pdf | 64 | 2 | 18, 26 |
| `rockwood_glass_solutions_2022.sqlite` | ROCKWOOD/7.29.22 Glass Solutions Price Book.pdf | 43 | 6 | 9, 19, 26-27, 37-38 |
| `rockwood_architectural_2025.sqlite` | ROCKWOOD/Rockwood Architectural Price Book - 3-3-25.pdf | 10 | 2 | 80, 85 |

**Total: 2781 product rows across 133 pages in 7 databases.**

## Field-level defects still open

| database | field | rows | what is wrong |
| --- | --- | ---: | --- |
| `hager_price_book_18.sqlite` | `price_row.size_raw` | 2615 | holds every size printed in the table, glued together (`'4-1/2" x 4-1/2" 4-1/2" x 4-1/2" ... 4-1/2" x 4-3/8"'`) instead of the row's own size. Prices are unaffected. Recovering it needs the block geometry: Hager prints the size cell on the price rows in some tables and on separate lines between them in others. |
| `bobrick_price_list_2020.sqlite` | `item.description_raw` | 4 | a description word past x≈385 is dropped — items 23, 24, 26, 27 read `'Bright Polished Stainless with 3" Shank'`, missing `Steel`. Models and prices are correct. |
| `bradley_price_book_2026.sqlite` | `section.name_raw` | 8 | a table header captured as a section name (`'Description Series'` on pages 30-36, `'401 coinage)'` on page 18). |

## What was verified clean

- All 17 databases match their source PDF byte for byte (sha256, size, page count).
- `page.raw_text` is identical to a fresh PyMuPDF 1.25.3 extraction on every page
  of every document; the `word` table matches too, apart from stripped Unicode
  spaces and one duplicate overprint on Rockwood accessories p11.
- Every `*_raw` -> numeric parse is consistent across all 17 databases (0 errors).
- Every price that *was* extracted traces back to its source line: Hager
  `price_row.list_raw` (8,804) and `row_cell.value_raw` (25,269), Rockwood
  accessories/architectural `row_cell` , Bradley `item.price_raw`, Bobrick
  `item.net_cost_raw` / `model_price_index` / `part_price`, markar-pemko
  `item_price.price_raw` — 0 mismatches.
- `ngp_price_list_2026`, `ngp_threshold_catalog`, `gamco_price_list_2020`,
  `nudo_frp_2026`, `nudo_vinyl_moldings_2026`, `pemko_buying_program_2020`,
  `rockwood_lites_louvers_2023`, `world_dryer_pricing_memo_2022` and
  `hager_multipliers_2026` are clean on every check.
