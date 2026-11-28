/** Resolve the app's card link scheme to a card and optional printed face. */
export function cardTarget(target: string) {
  if (!target.startsWith('card://')) return;
  const address = target.slice(7);
  const suffix = /:(front|back)$/.exec(address);
  try {
    const name = decodeURIComponent(suffix ? address.slice(0, suffix.index) : address).trim();
    if (name && !/[\p{Cc}]/u.test(name)) return { name, face: suffix?.[1] === 'back' ? 'back' as const : 'front' as const };
  } catch {
    // Retain malformed legacy authoring verbatim.
  }
}
