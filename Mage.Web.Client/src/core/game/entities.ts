import { HTML4_ENTITIES } from './html4Entities';

/** Existing typography substitutions and permissive legacy spellings, alongside the complete HTML 4 table. */
const LEGACY_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '—', ndash: '–', minus: '−', bull: '•',
  middot: '·', hellip: '…', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', times: '×', rarr: '→', larr: '←',
  laquo: '«', raquo: '»',
};

/**
 * Decodes HTML entities in one pass (so "&amp;lt;" stays "&lt;"). The server writes some without their semicolon
 * ("&bull Put a counter", from Modes and a few cards): a known name decodes either way (#204); anything else is left
 * as written.
 */
export function decodeEntities(text: string, { literal = false }: { literal?: boolean } = {}): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    }
    if (literal) {
      // User chat preserves curly quotes too; log/prompt typography keeps its historical substitutions.
      return HTML4_ENTITIES[body] ?? (body === 'apos' ? "'" : undefined) ?? match;
    }
    return LEGACY_ENTITIES[body] ?? HTML4_ENTITIES[body] ?? LEGACY_ENTITIES[body.toLowerCase()] ?? match;
  });
}
