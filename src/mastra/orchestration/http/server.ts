/**
 * Minimal Meta Front v2 HTTP server (plan §17) — skeleton transport.
 *
 * A thin `node:http` router over the framework-agnostic handlers. It is
 * deliberately standalone (not wired into the production Mastra server yet) so
 * the slice is testable "over the wire" without touching running routes.
 *
 * Auth is a STUB: `resolveAuth` reads `x-resource-id` / `x-principal-id` headers
 * to stand in for what real token validation would produce. Production MUST
 * replace `resolveAuth` with real credential → resource resolution; the handlers
 * never trust the body for identity, so that swap is the only change needed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Db, MongoClient } from 'mongodb';
import { createOrchestrationApi, type AuthContext, type ApiResponse } from './handlers.js';

export type AuthResolver = (req: IncomingMessage) => AuthContext | null;

/** Dev/test stub. Do not use in production. */
export const headerAuthStub: AuthResolver = (req) => {
  const resourceId = req.headers['x-resource-id'];
  const principalId = req.headers['x-principal-id'];
  if (typeof resourceId !== 'string' || resourceId.length === 0) return null;
  return { resourceId, principalId: typeof principalId === 'string' ? principalId : resourceId };
};

async function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('payload_too_large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function send(res: ServerResponse, r: ApiResponse): void {
  const payload = JSON.stringify(r.body);
  res.writeHead(r.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export interface HttpServerOpts {
  client: MongoClient;
  db: Db;
  resolveAuth?: AuthResolver;
}

const CONV_COMMANDS = /^\/v2\/conversations\/([^/]+)\/commands$/;
const CONV_JOBS = /^\/v2\/conversations\/([^/]+)\/jobs$/;
const CONV_PROJECTIONS = /^\/v2\/conversations\/([^/]+)\/projections$/;
const JOB = /^\/v2\/jobs\/([^/]+)$/;
const JOB_COMMANDS = /^\/v2\/jobs\/([^/]+)\/commands$/;

export function createOrchestrationHttpServer(opts: HttpServerOpts): Server {
  const api = createOrchestrationApi(opts.client, opts.db);
  const resolveAuth = opts.resolveAuth ?? headerAuthStub;

  return createServer((req, res) => {
    void (async () => {
      try {
        const rawUrl = req.url ?? '';
        const url = rawUrl.split('?')[0]!;
        const query = new URLSearchParams(rawUrl.split('?')[1] ?? '');
        const method = req.method ?? 'GET';

        const auth = resolveAuth(req);
        if (!auth) return send(res, { status: 401, body: { error: 'unauthenticated' } });

        let m: RegExpMatchArray | null;

        if (method === 'POST' && (m = url.match(CONV_COMMANDS))) {
          return send(res, await api.startCommand(auth, decodeURIComponent(m[1]!), await readJsonBody(req)));
        }
        if (method === 'GET' && (m = url.match(CONV_JOBS))) {
          return send(res, await api.listJobs(auth, decodeURIComponent(m[1]!)));
        }
        if (method === 'GET' && (m = url.match(CONV_PROJECTIONS))) {
          return send(res, await api.getConversation(auth, decodeURIComponent(m[1]!), Number(query.get('after')) || 0));
        }
        if (method === 'GET' && (m = url.match(JOB))) {
          return send(res, await api.getJob(auth, decodeURIComponent(m[1]!)));
        }
        if (method === 'POST' && (m = url.match(JOB_COMMANDS))) {
          return send(res, await api.jobCommand(auth, decodeURIComponent(m[1]!), await readJsonBody(req)));
        }
        return send(res, { status: 404, body: { error: 'route_not_found' } });
      } catch (err) {
        const msg = (err as Error).message;
        const status = msg === 'payload_too_large' ? 413 : msg.includes('JSON') ? 400 : 500;
        return send(res, { status, body: { error: status === 500 ? 'internal_error' : msg } });
      }
    })();
  });
}
