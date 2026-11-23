import { decodeEntities } from '../game/entities';

/**
 * TALK and whispers are plain user text escaped once by MageServerImpl.chatSendMessage (HTML 4).
 * Decode exactly that transport layer. A typed "&iacute;" arrives as "&amp;iacute;" and stays literal;
 * decoded tags are also literal text, never markup. Server notices use the separate log HTML parser.
 */
export function chatText(message: string | null | undefined): string {
  return decodeEntities(message ?? '', { literal: true });
}
