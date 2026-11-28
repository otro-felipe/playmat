export const scopeLabels = {
  play: 'juego e invitaciones',
  chat: 'chat de partida',
  library: 'mazos de la cuenta',
  history: 'historial de la cuenta',
  'players:manage': 'crear y renombrar jugadores MCP persistentes en tu cuenta',
  'tournaments:manage': 'crear y comenzar tus torneos y liberar reservas obsoletas de tus propios jugadores',
}
export const scopesSupported = Object.keys(scopeLabels)
export const defaultScopes = ['play', 'library', 'chat']
