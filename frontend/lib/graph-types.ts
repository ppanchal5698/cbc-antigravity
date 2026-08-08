/**
 * OKF graph shapes and the pure helpers that render them.
 *
 * Kept separate from `graph.ts` because that module reads the filesystem: the
 * diagram is a client component, and importing a value from an fs-touching
 * module would drag `node:fs` into the browser bundle.
 */

export const NODE_CLASSES = [
  'BrandAccount',
  'HardwareSetTemplate',
  'CatalogProduct',
  'WallTypeMapping',
  'VendorEquivalence',
  'UncarriedDivisionPattern',
  'EstimatorCorrectionPattern',
] as const;

export type NodeClass = (typeof NODE_CLASSES)[number];

/** Only `id`, `class` and `confidence` are universal; the rest is class-dependent. */
export type GraphNode = {
  id: string;
  class: NodeClass | (string & {});
  confidence?: number;
  [field: string]: unknown;
};

export type GraphEdge = {
  source: string;
  target: string;
  type: string;
  quantity?: number;
  weight?: number;
  frequency?: number;
  sizing_rule?: string;
  [field: string]: unknown;
};

/** Short human labels; the raw class names stay visible in the detail panel. */
export const CLASS_LABEL: Record<string, string> = {
  BrandAccount: 'Brand accounts',
  HardwareSetTemplate: 'Hardware sets',
  CatalogProduct: 'Products',
  WallTypeMapping: 'Wall types',
  VendorEquivalence: 'Equivalences',
  UncarriedDivisionPattern: 'Not carried',
  EstimatorCorrectionPattern: 'Corrections',
};

/** The display name for a node, which differs per class. */
export function nodeLabel(node: GraphNode): string {
  const pick = (key: string) => (typeof node[key] === 'string' ? (node[key] as string) : null);
  switch (node.class) {
    case 'CatalogProduct':
      return [pick('vendor'), pick('model')].filter(Boolean).join(' ') || node.id;
    case 'WallTypeMapping':
      return pick('wall_description') || node.id;
    case 'VendorEquivalence':
      return `${pick('specified_model') ?? '?'} → ${pick('proposed_model') ?? '?'}`;
    case 'UncarriedDivisionPattern':
      return pick('csi_division') || node.id;
    case 'EstimatorCorrectionPattern':
      return pick('trigger_context') || node.id;
    default:
      return pick('name') || node.id;
  }
}
