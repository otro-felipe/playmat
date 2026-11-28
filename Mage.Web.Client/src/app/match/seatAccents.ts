import { createContext } from 'react';

/** The colors each seat's archetype is drawn in, by the seat's display name, when the page knows them (a tournament replay). */
export const SeatAccents = createContext<Readonly<Record<string, readonly string[] | null>> | null>(null);
