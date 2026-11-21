export type SeatDisplayNames = Readonly<Record<string, string>>;

export function seatAlias(name: string, aliases?: SeatDisplayNames) {
  return aliases && Object.hasOwn(aliases, name) ? aliases[name] : undefined;
}
