/**
 * Gateway auth check. Run with `npm run check:auth`.
 *
 * The rule this file exists to hold: exposure requires a token. A shared secret that
 * defaults to "off" fails open exactly when it starts mattering, so the failure has to be
 * at boot, on the configuration that reaches beyond this host.
 */
import assert from 'node:assert/strict';

function load(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Fresh module instance: GATEWAY_TOKEN and BIND_ADDR are read at load.
  return import(`./auth.ts?${Math.random()}`) as Promise<typeof import('./auth.ts')>;
}

const req = (headers: Record<string, string> = {}) =>
  ({ headers }) as unknown as import('node:http').IncomingMessage;

// --- which addresses reach beyond this host --------------------------------
{
  const m = await load({ BIND_ADDR: '127.0.0.1', GATEWAY_TOKEN: undefined });
  for (const addr of ['127.0.0.1', 'localhost', '::1', ' 127.0.0.1 ']) {
    assert.equal(m.bindsBeyondLoopback(addr), false, `${addr} is loopback`);
  }
  for (const addr of ['0.0.0.0', '192.168.1.10', '::']) {
    assert.equal(m.bindsBeyondLoopback(addr), true, `${addr} reaches further`);
  }
}

// --- loopback without a token: allowed, the OS is the boundary -------------
{
  const m = await load({ BIND_ADDR: '127.0.0.1', GATEWAY_TOKEN: undefined });
  m.assertAuthConfigured();
  assert.equal(m.authorized(req()), true, 'no token configured means no token required');
}

// --- exposed without a token: refuses to START, not to serve ---------------
{
  const m = await load({ BIND_ADDR: '0.0.0.0', GATEWAY_TOKEN: undefined });
  assert.throws(() => m.assertAuthConfigured(), /GATEWAY_TOKEN/,
    'binding beyond loopback with no token must not start');
}

// --- token configured: every request needs it ------------------------------
{
  const m = await load({ BIND_ADDR: '0.0.0.0', GATEWAY_TOKEN: 's3cret-token-value' });
  m.assertAuthConfigured();

  assert.equal(m.authorized(req({ authorization: 'Bearer s3cret-token-value' })), true);
  assert.equal(m.authorized(req({ 'x-gateway-token': 's3cret-token-value' })), true);

  assert.equal(m.authorized(req()), false, 'no header is not authorised');
  assert.equal(m.authorized(req({ authorization: 'Bearer wrong' })), false, 'wrong token');
  assert.equal(m.authorized(req({ authorization: 'Bearer ' })), false, 'empty bearer');
  assert.equal(m.authorized(req({ authorization: 's3cret-token-value' })), false,
    'the scheme is part of the contract');
  assert.equal(m.authorized(req({ authorization: 'Bearer s3cret-token-value-extra' })), false,
    'a prefix of the token is not the token');
  assert.equal(m.authorized(req({ authorization: 'Bearer s3cret' })), false,
    'a shorter wrong token must not throw on the length mismatch');
}

console.log('gateway auth check passed');
