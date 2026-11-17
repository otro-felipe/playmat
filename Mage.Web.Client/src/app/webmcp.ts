import { useEffect, useRef } from 'react';

type PrimitiveProperty =
  | { type: 'string'; description: string }
  | { type: 'integer'; description: string; minimum?: number; maximum?: number }
  | { type: 'array'; description: string; items: { type: 'integer' } };
type ToolProperty = PrimitiveProperty | { description: string; anyOf: readonly PrimitiveProperty[] };

interface SiteTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolProperty>;
    required?: readonly string[];
    additionalProperties: false;
  };
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
}

type Execute = (input: Record<string, unknown>, signal: AbortSignal) => unknown;

interface ModelContext {
  registerTool(tool: SiteTool & {
    execute(input: Record<string, unknown>, options?: { signal?: AbortSignal }): unknown;
  }, options: { signal: AbortSignal }): Promise<void> | void;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Hosted tools belong to the signed-in page's own server. Local development also uses a separate port. */
export function isSiteToolOrigin(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);
    if (url.username || url.password) return false;
    if (location.protocol === 'https:' && url.protocol === 'wss:' && url.host === location.host) return true;
    return isLoopback(location.hostname) && isLoopback(url.hostname) && (url.protocol === 'ws:' || url.protocol === 'wss:');
  } catch {
    return false;
  }
}

export const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const;

/** Own a tool for the life of this route and its authenticated scope. */
export function useSiteTool(enabled: boolean, tool: SiteTool, execute: Execute, scope?: string): void {
  const latest = useRef(execute);
  useEffect(() => {
    latest.current = execute;
  }, [execute]);

  useEffect(() => {
    if (!enabled || !globalThis.isSecureContext) return;
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (typeof context?.registerTool !== 'function') return;
    const controller = new AbortController();
    // Defer registration so the cleanup from React Strict Mode does not leave a duplicate tool.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      const register = async () => context.registerTool({
        ...tool,
        execute(input, options) {
          const signal = options?.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal;
          signal.throwIfAborted();
          return latest.current(input ?? {}, signal);
        },
      }, { signal: controller.signal });
      void register().catch(() => {
        if (!controller.signal.aborted) console.warn(`Could not register site tool ${tool.name}`);
      });
    });
    return () => controller.abort();
  }, [enabled, tool, scope]);
}
