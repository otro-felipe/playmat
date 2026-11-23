export const scopeLabels = {
  play: 'juego e invitaciones',
  chat: 'chat de partida',
  library: 'mazos de la cuenta',
  history: 'historial de la cuenta',
  'players:manage': 'crear jugadores MCP persistentes en tu cuenta',
  'tournaments:manage': 'crear torneos con tu cuenta de organizador',
}
export const scopesSupported = Object.keys(scopeLabels)
export const defaultScopes = ['play', 'library', 'chat']
