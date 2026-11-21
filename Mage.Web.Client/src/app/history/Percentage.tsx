import { rate } from './performance';

/** Each half interpolates to keep the midpoint amber. A missing sample has no hue. */
export function Percentage({ count, total }: { count: number; total: number }) {
  if (!total) return <span>—</span>;
  const fraction = Math.max(0, Math.min(1, count / total));
  const hue = fraction <= 0.5 ? 6 + fraction * 72 : 42 + (fraction - 0.5) * 204;
  return <span style={{ color: `hsl(${hue} 73% 72%)` }}>{rate(count, total)}</span>;
}
