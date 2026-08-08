import { parseCitations } from './citations.ts';

/**
 * Turns the workflow's audit tags into elements during markdown rendering.
 *
 * Hand-rolled rather than pulling in `unist-util-visit`: the walk is eight
 * lines and this keeps the dependency list honest. Code spans are skipped so a
 * model number inside backticks is never rewritten, and existing links are left
 * alone.
 */
type TextNode = { type: 'text'; value: string };
type ElementNode = {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};
type HastNode = TextNode | ElementNode | { type: string; children?: HastNode[] };

const SKIP = new Set(['code', 'pre', 'a']);

function isElement(node: HastNode): node is ElementNode {
  return node.type === 'element';
}

/**
 * Unified plugin factory. Pass as `[rehypeCitations, vendorFolders]` — never
 * call it yourself and hand unified the returned transformer; unified always
 * invokes plugins as factories, so a pre-bound transform gets called with no
 * tree and crashes on `.children`.
 */
export function rehypeCitations(vendorFolders: string[]) {
  return function transform(tree: HastNode): void {
    if (!tree) return;
    walk(tree);

    function walk(node: HastNode): void {
      const children = (node as { children?: HastNode[] }).children;
      if (!children?.length) return;

      const next: HastNode[] = [];
      for (const child of children) {
        if (child.type === 'text') {
          const parts = parseCitations((child as TextNode).value, vendorFolders);
          if (parts.length === 1 && typeof parts[0] === 'string') {
            next.push(child);
            continue;
          }
          for (const part of parts) {
            if (typeof part === 'string') {
              if (part) next.push({ type: 'text', value: part });
              continue;
            }
            next.push({
              type: 'element',
              tagName: part.href ? 'a' : 'span',
              properties: {
                className: ['cbc-cite'],
                'data-cite': part.tag,
                'data-gap': part.gap ? 'true' : 'false',
                ...(part.href ? { href: part.href } : {}),
              },
              children: [
                { type: 'text', value: part.subject ? `${part.tag} ${part.subject}` : part.tag },
              ],
            });
          }
          continue;
        }

        if (!isElement(child) || !SKIP.has(child.tagName)) walk(child);
        next.push(child);
      }

      (node as { children?: HastNode[] }).children = next;
    }
  };
}
