import worker, { BuildCoordinator } from './index';

export { BuildCoordinator };

type RuntimeEnv = Record<string, unknown> & {
  DB?: D1Database;
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string | CryptoKey;
};

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function normalizeBindValue(value: unknown): unknown {
  return value === undefined ? null : value;
}

function normalizeD1(db: D1Database): D1Database {
  return {
    prepare(query: string) {
      const statement = db.prepare(query);
      return {
        bind(...values: unknown[]) {
          let normalizedValues = values.map(normalizeBindValue);

          // index.ts currently has two scaffolding persistence calls with three
          // SQL placeholders but only two bind arguments. Repair that legacy
          // call shape at the D1 boundary so builds cannot fail on bind arity.
          if (
            query === 'UPDATE projects SET scaffolding_json = ?, updated_at = ? WHERE id = ?' &&
            normalizedValues.length === 2
          ) {
            normalizedValues = [normalizedValues[0], new Date().toISOString(), normalizedValues[1]];
          }

          return statement.bind(...normalizedValues);
        },
        first: statement.first.bind(statement),
        run: statement.run.bind(statement),
        all: statement.all.bind(statement),
        raw: statement.raw.bind(statement),
      } as D1PreparedStatement;
    },
    batch: db.batch.bind(db),
    exec: db.exec.bind(db),
    dump: db.dump.bind(db),
  } as D1Database;
}

async function normalizeRuntimeEnv<T extends RuntimeEnv>(env: T): Promise<T> {
  const normalized = { ...env } as T;

  if (env.DB) {
    normalized.DB = normalizeD1(env.DB) as T['DB'];
  }

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
