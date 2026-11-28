const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
type Heading = typeof headings[number];
type TextBlock = { kind: 'p' | 'ul' | 'ol'; lines: string[]; start?: number };
type MarkdownBlock = TextBlock | { kind: Heading; lines: string[]; start?: never };

export function markdownBlocks(text: string): TextBlock[];
export function markdownBlocks(text: string, withHeadings: true): MarkdownBlock[];
export function markdownBlocks(text: string, withHeadings = false): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let current: MarkdownBlock | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      current = undefined;
      continue;
    }
    const heading = withHeadings ? /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line) : null;
    if (heading) {
      blocks.push({ kind: headings[heading[1].length - 1], lines: [heading[2]] });
      current = undefined;
      continue;
    }
    const item = /^(?:[-+*]|(\d{1,9})[.)])\s+(.+)$/.exec(line);
    const kind = item ? item[1] ? 'ol' : 'ul' : 'p';
    if (current?.kind !== kind) {
      current = { kind, lines: [], ...(item?.[1] ? { start: Number(item[1]) } : {}) };
      blocks.push(current);
    }
    current.lines.push(item?.[2] ?? line);
  }
  return blocks;
}
