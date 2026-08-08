/**
 * Makes a partially-streamed markdown string safe to parse right now.
 *
 * Without this, a half-written ``` fence makes react-markdown reinterpret the
 * rest of the document on every token, which is what causes the flashing you
 * see in naive streaming renderers.
 */
export function completeMarkdown(text: string): string {
  if (!text) return text;
  let out = text;

  // An open fenced block: close it so the tail renders as code, not prose.
  const fences = out.match(/^\s{0,3}```/gm);
  if (fences && fences.length % 2 === 1) {
    if (!out.endsWith('\n')) out += '\n';
    out += '```';
    return out;
  }

  // An odd number of single backticks on the last line: close the inline span.
  const lastLine = out.slice(out.lastIndexOf('\n') + 1);
  const inline = lastLine.match(/`/g);
  if (inline && inline.length % 2 === 1) out += '`';

  return out;
}
