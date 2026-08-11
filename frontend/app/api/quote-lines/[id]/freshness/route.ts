import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { checkFreshness, toStoredFreshness } from '@/lib/freshness';
import { patchQuoteLine } from '@/lib/quote-draft';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Re-check one line's cost age against the engine and store the verdict (NR-2).
 *
 * A read plus a write, not a mutation of the price: the cost is unchanged, only what we
 * know about its age. The estimator still decides what to do about it — that is the
 * "price may be out of date — refresh" prompt CBC asked for, and the refresh is theirs.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    const rows = await query<{ cost_basis: string }>(
      'SELECT cost_basis FROM quote_lines WHERE id = $1',
      [id],
    );
    if (!rows[0]) return NextResponse.json({ error: 'Line not found' }, { status: 404 });

    const result = await checkFreshness(rows[0].cost_basis);
    const stored = toStoredFreshness(result.status);

    // Through patchQuoteLine so the approved-draft lock applies here too: a verdict
    // written onto a line in an approved draft would change what was signed off.
    const written = await patchQuoteLine(id, { price_freshness: stored });
    if (!written.ok) {
      return written.reason === 'approved'
        ? NextResponse.json(
            { ...result, stored: null, note: 'This draft is approved; the verdict was not stored.' },
            { status: 409 },
          )
        : NextResponse.json({ error: 'Line not found' }, { status: 404 });
    }

    return NextResponse.json({ ...result, stored, line: written.value });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
