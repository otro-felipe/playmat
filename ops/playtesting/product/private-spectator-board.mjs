import { isUuid } from './decks.mjs'
import { publicSpectatorBoard } from './public-spectator-board.mjs'

const text = (value, length=200) => typeof value==='string' && value.length>0 && value.length<=length && !/[\u0000-\u001f\u007f]/u.test(value)

// Keep only the visible printed face. A seat CardView can carry nested originals,
// command IDs and helper state even when its current face is concealed.
function face(id,card) {
  if (!isUuid(id) || !card || card.id && card.id!==id || card.faceDown || card.hideInfo || !text(card.name)) return null
  const out={id,name:card.name}
  if (text(card.expansionSetCode,8)) out.expansionSetCode=card.expansionSetCode
  if (text(card.cardNumber,16)) out.cardNumber=card.cardNumber
  for (const field of ['manaCostLeftStr','power','toughness','loyalty','defense']) if (text(card[field],64)) out[field]=card[field]
  for (const field of ['cardTypes','subTypes','superTypes']) if (Array.isArray(card[field])) out[field]=card[field].filter(v=>text(v,48))
  return out
}
function cards(zone) {
  if (!zone || typeof zone!=='object' || Array.isArray(zone)) return {}
  // Card IDs identify visible cards. Map iteration must not encode library order.
  return Object.fromEntries(Object.keys(zone).sort().flatMap(id=>{
    const card=face(id,zone[id])
    return card?[[id,card]]:[]
  }))
}
function groups(items) {
  return (Array.isArray(items)?items:[]).map(group=>({cards:cards(group?.cards)})).filter(group=>Object.keys(group.cards).length)
}

// SpectatorTable labels only player-authored TALK received from this game's chat.
function tableChat(rows, gameId, players) {
  const names=new Set(players.map(player=>player.name))
  const prefix=gameId+':'
  return (Array.isArray(rows)?rows:[]).filter(row=>row?.type==='TALK' && names.has(row.playerName)
    && typeof row.messageId==='string' && row.messageId.startsWith(prefix) && /^(?:event-)?[0-9]+$/.test(row.messageId.slice(prefix.length))
    && typeof row.message==='string' && [...row.message].length>0 && [...row.message].length<=500
    && Number.isSafeInteger(row.at)).slice(-100).map(({messageId,playerName,message,at})=>({messageId,playerName,message,at}))
}

export function privateSpectatorBoard(frame) {
  const out={...publicSpectatorBoard(frame),visibility:'both-hands',seatKnowledge:{}}
  if (out.status!=='playing' || !out.view || out.players.length!==2) return out
  out.chat=tableChat(frame.chat,out.gameId,out.players)
  for (const {playerId} of out.players) {
    if (!isUuid(playerId)) continue
    out.hands[playerId]=cards(frame.hands?.[playerId])
    const seat=frame.seatKnowledge?.[playerId]
    const top=face(seat?.topCard?.id,seat?.topCard)
    out.seatKnowledge[playerId]={lookedAt:groups(seat?.lookedAt),revealed:groups(seat?.revealed),...(top?{topCard:top}:{})}
  }
  return out
}
