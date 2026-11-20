import type { CardView, PermanentView } from '../../protocol/generated/views';

export interface RoomDoor {
  name: string;
  unlocked: boolean;
}

/** A Room permanent's two doors, left first, as the server tells them (null: not a face-up Room). */
export function roomDoors(permanent: Pick<PermanentView, 'faceDown' | 'hideInfo' | 'roomLeftDoor' | 'roomRightDoor' | 'roomLeftUnlocked' | 'roomRightUnlocked'>): [RoomDoor, RoomDoor] | null {
  if (permanent.faceDown || permanent.hideInfo || !permanent.roomLeftDoor || !permanent.roomRightDoor) return null;
  return [
    { name: permanent.roomLeftDoor, unlocked: !!permanent.roomLeftUnlocked },
    { name: permanent.roomRightDoor, unlocked: !!permanent.roomRightUnlocked },
  ];
}

/** The engine projects the chosen half's characteristics on the stack, even if the art shows both doors. */
export function roomCastDoor(spell: CardView): string | null {
  if (spell.faceDown || spell.hideInfo || spell.mageObjectType !== 'SPELL' || !spell.subTypes?.includes('ROOM')) return null;
  const name = spell.name;
  return name && !spell.isSplitCard && !name.includes('//') ? name : null;
}
