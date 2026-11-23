import { createMcpServer } from './server.mjs';
import { PlaymatEngineSeat } from './engine-seat.mjs';
import { configuredSeatCapacity } from './player-seats.mjs';
import { createProductClient } from './product.mjs';

const engineUrl = process.env.PLAYMAT_ENGINE_URL ?? 'ws://127.0.0.1:17172/ws';
const productUrl = process.env.PLAYMAT_PRODUCT_URL ?? 'http://127.0.0.1:8790';
const trustedHeader = process.env.AUTH_TRUSTED_HEADER ?? 'X-Playmat-User';
const publicUrl = process.env.PLAYMAT_PUBLIC_URL;
const product = createProductClient(productUrl, publicUrl);
const port = Number(process.env.PLAYMAT_MCP_PORT ?? 8791);
const allowedOrigins = (process.env.PLAYMAT_MCP_ALLOWED_ORIGINS ?? process.env.XMAGE_ALLOWED_ORIGINS ?? '')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
const invitationOrigin=publicUrl ? new URL(publicUrl).origin : undefined;
if (invitationOrigin) allowedOrigins.push(invitationOrigin);
allowedOrigins.push('https://chatgpt.com');

const server = createMcpServer({
  maxSeats: configuredSeatCapacity(process.env.PLAYMAT_MCP_MAX_SEATS),
  authorize: product.authorize,
  product: product.operation,
  eventRequest: product.eventRequest,
  publishSeatEvent: product.publishSeatEvent,
  oauthResourceMetadata: publicUrl?.startsWith('https://')
    ? new URL('/.well-known/oauth-protected-resource/mcp', publicUrl).href : undefined,
  createEngine: ({ engineName, canonicalAgent, accountId, recoverySeatId, connectionId, humanTableId, playerId, activeTableId, flag }) => new PlaymatEngineSeat({
    engineUrl, engineName, canonicalAgent, accountId, recoverySeatId, connectionId, humanTableId,
    playerId, activeTableId, flag, trustedHeader, managedPriorityStops: true,
  }),
  invitationOrigin, allowedOrigins,
});

server.listen(port, '127.0.0.1', () => console.log('Playmat MCP listening on loopback.'));
function stop() {
  server.close();
  server.closeAllConnections();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
