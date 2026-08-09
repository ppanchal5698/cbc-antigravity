import { NextResponse } from 'next/server';
import { addQuoteLine, getDraftByRunId, type QuoteSection } from '@/lib/quote-draft';

export const dynamic = 'force-dynamic';

const SECTIONS = new Set<QuoteSection>(['door', 'accessory', 'frp', 'custom']);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const section = String(body.section ?? 'custom') as QuoteSection;
  if (!SECTIONS.has(section)) {
    return NextResponse.json({ error: 'Invalid section' }, { status: 400 });
  }

  try {
    const payload = await getDraftByRunId(id);
    if (!payload) {
      return NextResponse.json({ error: 'Quote draft not found' }, { status: 404 });
    }

    // `addQuoteLine` re-checks the approved lock itself; this only shapes the message.
    const result = await addQuoteLine(payload.draft.id, {
      section,
      tag: typeof body.tag === 'string' ? body.tag : '',
      room: typeof body.room === 'string' ? body.room : undefined,
      description: typeof body.description === 'string' ? body.description : '',
      qty: typeof body.qty === 'number' && Number.isFinite(body.qty) ? body.qty : 1,
      unit: typeof body.unit === 'string' ? body.unit : 'EA',
      unit_sale:
        typeof body.unit_sale === 'number' && Number.isFinite(body.unit_sale)
          ? body.unit_sale
          : 0,
      cost_basis: typeof body.cost_basis === 'string' ? body.cost_basis : undefined,
      citations: typeof body.citations === 'string' ? body.citations : undefined,
      substitution_notes:
        typeof body.substitution_notes === 'string' ? body.substitution_notes : null,
    });

    if (!result.ok) {
      return result.reason === 'approved'
        ? NextResponse.json({ error: 'Draft is already approved' }, { status: 409 })
        : NextResponse.json({ error: 'Quote draft not found' }, { status: 404 });
    }
    return NextResponse.json({ line: result.value });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
