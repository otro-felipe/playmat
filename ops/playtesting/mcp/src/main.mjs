import { createMcpServer } from './server.mjs';
import { PlaymatEngineSeat } from './engine-seat.mjs';
import { createProductClient } from './product.mjs';

const engineUrl = process.env.PLAYMAT_ENGINE_URL ?? 'ws://127.0.0.1:17172/ws';
const productUrl = process.env.PLAYMAT_PRODUCT_URL ?? 'http://127.0.0.1:8790';
const trustedHeader = process.env.AUTH_TRUSTED_HEADER ?? 'X-Playmat-User';
const publicUrl = process.env.PLAYMAT_PUBLIC_URL;
const product = createProductClient(productUrl, publicUrl);
const port = Number(process.env.PLAYMAT_MCP_PORT ?? 8791);

const server = createMcpServer({
  authorize: product.authorize,
  product: product.operation,
  createEngine: ({ engineName }) => new PlaymatEngineSeat({ engineUrl, engineName, trustedHeader }),
  allowedOrigins: publicUrl ? [new URL(publicUrl).origin] : [],
});

server.listen(port, '127.0.0.1', () => console.log('Playmat MCP listening on loopback.'));
function stop() {
  server.close();
  server.closeAllConnections();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
