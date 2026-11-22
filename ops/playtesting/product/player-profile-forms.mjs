import { createPlayer, updatePlayer } from './players.mjs'
import { ProductError } from './decks.mjs'

export const playerPage = '/oauth/connections?view=players'

export async function savePlayerForm(pool, owner, form) {
  const input = {
    displayName: form.get('displayName'),
    flag: form.get('flag') || null,
    mcpEnabled: form.get('mcpEnabled') === 'on',
  }
  switch (form.get('action')) {
    case 'create': return createPlayer(pool, owner, input)
    case 'update': return updatePlayer(pool, owner, form.get('playerId'), input)
    default: throw new ProductError(400, 'Acción de jugador inválida')
  }
}

export function renderPlayerForms(players, escape) {
  function form(player) {
    const flag = player?.flag
    const emoji = /^[A-Z]{2}$/.test(flag ?? '') ? String.fromCodePoint(...Array.from(flag, c => 127397 + c.charCodeAt(0))) : ''
    const heading = player ? [emoji, escape(player.displayName)].filter(Boolean).join(' ') : 'Nuevo jugador'
    return `<section><h2>${heading}</h2>
      <form method="post" action="${playerPage}">
      <input type="hidden" name="action" value="${player ? 'update' : 'create'}">
      ${player ? `<input type="hidden" name="playerId" value="${escape(player.playerId)}">` : ''}
      <label>Nombre del jugador<input name="displayName" maxlength="40" required value="${escape(player?.displayName ?? '')}"></label>
      <label>Bandera (código de país)<input name="flag" maxlength="2" pattern="[A-Za-z]{2}" placeholder="CL" value="${escape(flag ?? '')}"></label>
      <label><span><input type="checkbox" role="switch" name="mcpEnabled"${player?.mcpEnabled ? ' checked' : ''}> Permitir conexiones MCP</span></label>
      <button type="submit">${player ? 'Guardar cambios' : 'Crear jugador'}</button></form></section>`
  }
  return '<a href="/oauth/connections">Volver a conexiones MCP</a>' + players.map(form).join('') + form(null)
}
