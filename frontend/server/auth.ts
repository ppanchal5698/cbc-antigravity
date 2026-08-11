/**
 * Who may talk to the gateway.
 *
 * There is no user model here and no session store, so this is not a login — it is a
 * shared secret that distinguishes "the Quote Desk web app" from "anything else that can
 * reach the port". That is the gap that actually mattered: `POST /chat` spawns `agy` with
 * `--dangerously-skip-permissions`, read-write on the whole workspace, and the domain gate
 * in front of it is a SCOPE classifier — it decides whether a message is estimating work,
 * never whether the sender is entitled to ask.
 *
 * The rule is: **exposure requires a token.** Bound to loopback the token is optional,
 * because the OS is already the boundary and demanding one would break every existing
 * single-host install for no gain. Bound anywhere else it is mandatory, and the gateway
 * refuses to start without it rather than listening unauthenticated on a network.
 *
 * That ordering is deliberate. A token that defaults to "off" fails open the moment
 * someone widens BIND_ADDR, which is exactly when it needs to be on.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const BIND_ADDR = process.env.BIND_ADDR || '127.0.0.1';

/** Loopback literals. Anything else reaches beyond this host. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function bindsBeyondLoopback(addr: string = BIND_ADDR): boolean {
  return !LOOPBACK.has(addr.trim());
}

/**
 * Called at boot. Throws rather than starting a gateway that would be reachable and
 * unauthenticated — the one configuration nobody should be able to reach by accident.
 */
export function assertAuthConfigured(): void {
  if (bindsBeyondLoopback() && !GATEWAY_TOKEN) {
    throw new Error(
      `BIND_ADDR is ${BIND_ADDR}, which is reachable beyond this host, but GATEWAY_TOKEN ` +
        'is not set. POST /chat spawns agy with --dangerously-skip-permissions and write ' +
        'access to the whole workspace, and nothing else here authenticates. Set ' +
        'GATEWAY_TOKEN (any long random string) in .env, or bind to 127.0.0.1.',
    );
  }
}

/** Constant-time compare that does not leak length through an early return. */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still burn a comparison so a wrong-length token is not distinguishable by timing.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * True when this request may proceed.
 *
 * With no token configured (loopback only, per `assertAuthConfigured`) everything is
 * allowed — the OS is the boundary. With one configured, every route needs it, including
 * `/health`: an unauthenticated health endpoint is a free confirmation that the port is
 * a CBC gateway, and it reports the workspace path and sign-in state.
 */
export function authorized(req: IncomingMessage): boolean {
  if (!GATEWAY_TOKEN) return true;

  const header = req.headers['authorization'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw?.startsWith('Bearer ')) return secretsMatch(raw.slice(7).trim(), GATEWAY_TOKEN);

  const alt = req.headers['x-gateway-token'];
  const token = Array.isArray(alt) ? alt[0] : alt;
  return token ? secretsMatch(token.trim(), GATEWAY_TOKEN) : false;
}
