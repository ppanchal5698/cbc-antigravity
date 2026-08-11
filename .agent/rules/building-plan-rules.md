---
name: building-plan-rules
description: Mandatory accuracy procedure for reading architectural plan sets with the building-plan-intelligence MCP server.
trigger: always_on
---

# Reading building plans

Applies whenever you work with a plan set through `building-plan-intelligence`.

These drawings are legal construction documents. A wrong model number or
dimension becomes a wrong order, a failed inspection, or a change order. The
cost of saying "the set does not state this" is nil. The cost of a confident
wrong answer is real. **Accuracy beats completeness every time.**

## The four rules

### 1. Schedules: `read_schedule`, never flat text

Any door, window, hardware, equipment, finish, fixture, or panel schedule must
be read with `read_schedule`. Sheet text interleaves columns from unrelated
tables, so reading a schedule from `get_sheet` silently pairs values with the
wrong row and drops rows entirely.

If `get_sheet` reports `tables_on_sheet > 0`, you are not done until you have
called `read_schedule` on that sheet.

### 2. Enumerate every row, and never assume a range

Count the rows `read_schedule` returns and account for all of them.

**Schedule numbering skips.** A door schedule reading 01, 02, 03, 06 has four
doors, not three and not six. Never infer that 04 and 05 exist, and never stop
at 03 because the next number is not 04. Report the tags exactly as they appear.

Also flag anything **referenced but never defined** — a row calling for
"GROUP 6" when only Groups 1–4 are scheduled is a real gap in the drawings and
is worth more to the reader than anything you could infer.

### 3. Cross-check before naming any product

Run `cross_reference` on every manufacturer, model, product line, and finish
before reporting it. Specifications and drawing schedules disagree in real sets
— a spec sheet may name one series and a note on the drawing another.

When sources disagree, **report both and flag the discrepancy.** Do not pick
one, do not average them, do not quietly prefer the spec. The conflict is
usually the most valuable thing you can tell the reader.

### 4. Verify every claim before you answer

Before writing your response, collect every factual claim — model number,
dimension, quantity, finish, material, gauge, quoted sign copy — and run
`verify_facts` on all of them in one call.

Anything returning `verified: false` **is not in this document.** Delete it or
replace it with the document's exact wording (`near_miss` shows you where the
real wording is). Never restore it from product knowledge.

**Read `verified_by`, not just `verified`.** The two answers are different kinds
of evidence:

- **`document`** — the claim is in the sheet's own text layer. This is the strong
  case, and the only one that can carry a `[schedule]` or `[spec]` tag.
- **`vision_reading`** — the claim is in text *you* wrote back with
  `record_vision_reading`. On a sheet whose text was outlined to vectors that is
  the only evidence there will ever be, so it counts and the takeoff proceeds.
  But it is your own transcription, and it cannot corroborate you. Tag it
  `[drawing]`, say it was read by eye, and never let it be the sole support for a
  model number, dimension, finish or price. If a schedule states the same thing,
  go and read the schedule.
- **`both`** — the vision pass agrees with the text layer. Strongest of all.

A claim verified only by your own vision reading is not the same as a verified
claim, however identical the `verified: true` looks.

This is the last step before answering. Not optional.

## Never supply detail the document does not

You know a great deal about construction products. That knowledge is useful for
knowing *where to look* and *what to search for*. It is never a source for what
this building uses.

Concretely, do not add:

- a product line name because the manufacturer is right (`Alarm Lock` in the
  schedule does not license writing `Alarm Lock Trilogy`)
- a gauge, alloy, or finish grade the spec does not state
- a mounting method, height, or location not on the drawings
- a dimension "typical" for that assembly
- an attribute carried over from a similar item elsewhere in the set

If the set does not say, write **"not stated in the set."** That is a complete,
correct, professional answer.

## Never render a whole sheet to read it

Sheets are 36x24in. Body text is 9–9.5pt, which lands at about **5 pixels** once
a full sheet is downsampled to a vision model's input budget — unreadable, and
you will hallucinate from it.

Use `render_sheet`, which tiles to a 3x2 grid where the same text lands at
~16px. Still too small? Raise `cols`/`rows`, **not `dpi`** — more tiles means
more pixels per inch of drawing after the model's resize, whereas raising DPI on
one big tile is undone by that resize. Use `region` to zoom a located detail.

Do not open plan PDFs with a generic file or image reader. Use the MCP server.

## Extract before you look

Text extraction is exact, instant and free; vision is slow, costly and
approximate. Spend vision only where the server says it is needed.

`vision_need` on every sheet:

- **`none`** — text layer intact; trust `read_schedule` / `read_layout`.
- **`identity`** — drawing is searchable but its title block was outlined, so
  the sheet number is unknown. Content is fine; only the label is missing.
- **`full`** — no text at all. Vision is the only option.

After reading tiles, always call `record_vision_reading` so the sheet becomes
searchable and nobody pays to read it twice. Include `sheet_no=A2.0` if you
identified the sheet number.

## Label every fact with where it came from

Cite the sheet number and title (`A2.2 - DETAILS, SCHEDULES, & PARTITIONS`), and
mark how you got it:

- **[schedule]** — a row from `read_schedule`. Strongest.
- **[spec]** — specification text from a G-series sheet.
- **[note]** — a general or keyed note on a drawing.
- **[drawing]** — read visually off a tile. Say so; a dimension read by eye is
  not as certain as one from a schedule. Anything `verify_facts` reports as
  `verified_by: vision_reading` belongs here, whatever it is about — the sheet
  was read by a model, and `verified: true` on that row means only that the same
  model wrote it down.
- **[not stated]** — the set does not say.

Never present these as equally certain, and never let knowledge from outside the
document enter without being labelled as such — ideally, not at all.
