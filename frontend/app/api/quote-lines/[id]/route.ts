import { NextResponse } from 'next/server';
import {
  patchQuoteLine,
  type LineAcceptance,
  type LinePatch,
  type PricingStatus,
  type LineConfidence,
  type PriceFreshness,
} from '@/lib/quote-draft';

export const dynamic = 'force-dynamic';

export async function PATCH(
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
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const patch: LinePatch = {};
  if (typeof body.tag === 'string') patch.tag = body.tag;
  if (typeof body.room === 'string') patch.room = body.room;
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.qty === 'number' && Number.isFinite(body.qty)) patch.qty = body.qty;
  if (typeof body.unit === 'string') patch.unit = body.unit;
  if (typeof body.unit_sale === 'number' && Number.isFinite(body.unit_sale)) {
    patch.unit_sale = body.unit_sale;
  }
  if (typeof body.cost_basis === 'string') patch.cost_basis = body.cost_basis;
  if (typeof body.citations === 'string') patch.citations = body.citations;
  if (body.confidence === null || body.confidence === 'HIGH' || body.confidence === 'MEDIUM' || body.confidence === 'LOW') {
    patch.confidence = body.confidence as LineConfidence | null;
  }
  if (body.acceptance === 'pending' || body.acceptance === 'accepted' || body.acceptance === 'rejected') {
    patch.acceptance = body.acceptance as LineAcceptance;
  }
  if (
    body.pricing_status === 'priced' ||
    body.pricing_status === 'manual_entry_required' ||
    body.pricing_status === 'awaiting_vendor_rfq'
  ) {
    patch.pricing_status = body.pricing_status as PricingStatus;
  }
  if (
    body.price_freshness === null ||
    body.price_freshness === 'fresh' ||
    body.price_freshness === 'review' ||
    body.price_freshness === 'stale'
  ) {
    patch.price_freshness = body.price_freshness as PriceFreshness | null;
  }
  if (typeof body.substitution_notes === 'string' || body.substitution_notes === null) {
    patch.substitution_notes = body.substitution_notes as string | null;
  }
  if ((typeof body.unit_cost === 'number' && Number.isFinite(body.unit_cost)) || body.unit_cost === null) {
    patch.unit_cost = body.unit_cost as number | null;
  }
  if ((typeof body.margin_rate === 'number' && Number.isFinite(body.margin_rate)) || body.margin_rate === null) {
    patch.margin_rate = body.margin_rate as number | null;
  }
  if (typeof body.deleted === 'boolean') patch.deleted = body.deleted;

  try {
    const result = await patchQuoteLine(id, patch);
    if (!result.ok) {
      return result.reason === 'approved'
        ? NextResponse.json(
            { error: 'This draft is approved. Lines can no longer be edited.' },
            { status: 409 },
          )
        : NextResponse.json({ error: 'Line not found' }, { status: 404 });
    }
    return NextResponse.json({ line: result.value });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
