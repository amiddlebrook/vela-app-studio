import worker, { BuildCoordinator } from './index';

export { BuildCoordinator };

type RuntimeEnv = Record<string, unknown> & {
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string | CryptoKey;
};

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function normalizeRuntimeEnv<T extends RuntimeEnv>(env: T): Promise<T> {
  const normalized = { ...env } as T;

  if (typeof env.SESSION_SECRET === 'string') {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.SESSION_SECRET));
    normalized.SESSION_SECRET = base64Url(new Uint8Array(digest));
  }

  if (typeof env.TOKEN_ENCRYPTION_KEY === 'string') {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.TOKEN_ENCRYPTION_KEY));
    normalized.TOKEN_ENCRYPTION_KEY = await crypto.subtle.importKey(
      'raw',
      digest,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  // index.ts contains older helper functions that reference `env` as a global.
  // Keep those helpers working while the control plane is migrated to explicit
  // dependency injection.
  (globalThis as typeof globalThis & { env?: T }).env = normalized;
  return normalized;
}

function runtimeError(error: unknown): Response {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: 'uncaught_request_error', reason }));
  return new Response(JSON.stringify({ error: 'Runtime request failed', reason }), {
    status: 500,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    try {
      return await worker.fetch(request, await normalizeRuntimeEnv(env as never));
    } catch (error) {
      return runtimeError(error);
    }
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const normalized = await normalizeRuntimeEnv(env as never);
    try {
      await worker.queue(batch as never, normalized as never);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'uncaught_queue_error', reason }));
      throw error;
    }
  },
};
