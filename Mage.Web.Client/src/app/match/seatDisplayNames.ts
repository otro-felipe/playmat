export type SeatDisplayNames = Readonly<Record<string, string>>;

/** Presentation only. Engine account names still identify players and authenticated chat authors. */
export function seatDisplayName(engineName: string, names?: SeatDisplayNames): string {
  return names && Object.hasOwn(names, engineName) ? names[engineName] : engineName;
}
