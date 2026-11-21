import { setTimeout as sleep } from 'node:timers/promises'

// The local MCP server emits this JSON-RPC error before dispatching a request.
// Transport exceptions and tool/engine timeouts have no such guarantee.
export function createFixtureMcpFetch(send = fetch, wait = sleep) {
  return async (url, init) => {
    for (let attempt = 1; ; attempt++) {
      const response = await send(url, init)
      if (response.status !== 429 || attempt === 6 || (init?.body != null && typeof init.body !== 'string')) return response
      const retryAfter = response.headers.get('retry-after')
      if (!/^([1-9]|[1-5][0-9]|60)$/.test(retryAfter ?? '')) return response
      const rejection = await response.clone().json().catch(() => null)
      if (rejection?.jsonrpc !== '2.0' || rejection.error?.code !== -32029) return response
      await response.body?.cancel()
      await wait(Number(retryAfter) * 1000, undefined, { signal: init?.signal ?? undefined })
    }
  }
}

export const fixtureMcpFetch = createFixtureMcpFetch()
