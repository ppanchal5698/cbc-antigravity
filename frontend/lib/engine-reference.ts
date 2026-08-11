import { gatewayFetch, GATEWAY_URL } from './gateway';

/**
 * Vendor multipliers and margin bands, fetched from the gateway (which reads
 * them out of the Python estimating engine). Cached briefly so a page render
 * never pays for a subprocess, and null on failure so the shelf degrades to
 * DB-only facts rather than showing a wrong multiplier.
 */
export type VendorTier = {
  vendor_name: string;
  multiplier: number | null;
  basis: string;
  effective_date: string;
  catalog_source?: string;
  notes: string;
  sourcing_type: string;
  manual_entry_prompt?: string;
  adders?: Record<string, Record<string, unknown>>;
};

export type MarginBand = { name: string; margin: number; divisor: number; note?: string };

export type EngineReference = {
  vendorTiers: Record<string, VendorTier>;
  marginBands: Record<string, MarginBand>;
  customerMargins: Record<string, Record<string, unknown>>;
  vendorAliases: Record<string, string>;
};

const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; value: EngineReference } | null = null;

export async function getEngineReference(): Promise<EngineReference | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const response = await gatewayFetch(`/engine/reference`, { cache: 'no-store' });
    if (!response.ok) return cache?.value ?? null;
    const value = (await response.json()) as EngineReference;
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return cache?.value ?? null;
  }
}

/**
 * Resolves a catalog folder name to its engine tier, following the engine's own
 * alias table. GAMCO has no folder of its own - its book is filed under
 * BOBRICK - and the five wholesalers have no folder at all.
 */
export function tierFor(
  reference: EngineReference | null,
  folder: string,
): { key: string; tier: VendorTier } | null {
  if (!reference) return null;
  const key = folder.trim().toUpperCase();
  const direct = reference.vendorTiers[key];
  if (direct) return { key, tier: direct };
  const aliased = reference.vendorAliases[key];
  if (aliased && reference.vendorTiers[aliased]) {
    return { key: aliased, tier: reference.vendorTiers[aliased] };
  }
  return null;
}

/** `x0.29 list` / `net` / `manual` - how a cost is reached for this vendor. */
export function formatTier(tier: VendorTier | null | undefined): string {
  if (!tier) return '—';
  if (tier.multiplier === null) return 'Manual net entry';
  if (tier.basis === 'net') return `Net cost each (x${tier.multiplier})`;
  return `x${tier.multiplier} list`;
}
