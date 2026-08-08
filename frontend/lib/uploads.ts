/**
 * Upload constraints, shared by the API route that enforces them and the file
 * input that hints at them. Kept free of `node:path` so the browser can import
 * it without dragging the filesystem helpers along.
 */
export const ALLOWED_EXTENSIONS = [
  '.pdf',
  '.xlsx',
  '.xls',
  '.docx',
  '.csv',
  '.png',
  '.jpg',
  '.jpeg',
] as const;

export function hasAllowedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
