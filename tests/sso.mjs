import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile('worker/index.js', 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
const core = await readFile('server/sso-core.js', 'utf8');
const { createSSOService } = await import('data:text/javascript;base64,' + Buffer.from(core + '\nexport {createSSOService};').toString('base64'));
const objects = new Map(); let revision = 0;
const bucket = {
  get: async key => { const object = objects.get(key); return object ? { etag: object.etag, json: async () => JSON.parse(object.body) } : null; },
  put: async (key, body, options = {}) => {
    if (options.onlyIf?.etagMatches !== undefined && objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
    const etag = String(++revision); objects.set(key, { body, etag }); return { etag };
  },
  delete: async key => objects.delete(key),
};
const origin = 'https://mapa.example.test', peerOrigin = 'https://agenda.example.test';
const env = { SITE_AUTH_MODE: 'oauth', MAP_ORIGIN: origin, BUCKET: bucket, SSO_PEER_ORIGIN: peerOrigin, SSO_SHARED_SECRET: 'A'.repeat(43), SSO_AUTO_LOGIN: 'true', AUTH_ALLOWED_DOMAINS: 'fundacaolemann.org.br,motriz.org', MAP_ADMIN_EMAILS: 'admin@fundacaolemann.org.br', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test-only' };
let peerUser = { userId: 'google:viewer', email: 'viewer@motriz.org', displayName: 'Pessoa', sessionExpiresAt: Date.now() + 3_600_000 };
const peer = createSSOService({ enabled: true, origin: peerOrigin, peerOrigin: origin, secret: env.SSO_SHARED_SECRET, getUser: async () => peerUser });
const request = (path, options = {}) => worker.fetch(new Request(origin + path, options), env);
async function begin() {
  const start = await request('/auth/sso/start');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const authorization = await peer.handle(new Request(start.headers.get('location')));
  const target = new URL(authorization.headers.get('location')), fragment = new URLSearchParams(target.hash.slice(1));
  const body = JSON.stringify({ state: fragment.get('state'), assertion: fragment.get('assertion') });
  return { complete: () => request('/auth/sso/complete', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body }) };
}
assert.equal((await request('/login')).headers.get('location'), '/auth/sso/start');
assert.equal((await request('/login?sso=skip')).status, 200);
let flow = await begin();
const responses = await Promise.all([flow.complete(), flow.complete()]);
const completed = responses.filter(response => response.headers.getSetCookie().some(value => value.startsWith('__Host-mapa_session=')));
assert.equal(completed.length, 1, 'R2 conditional update must reject concurrent replay');
const session = completed[0].headers.getSetCookie().find(value => value.startsWith('__Host-mapa_session=')).split(';')[0];
assert.equal((await (await request('/api/session', { headers: { cookie: session } })).json()).canEdit, false, 'SSO must not grant administration');
assert.equal((await request('/', { headers: { cookie: session } })).status, 200);
const saved = [...objects.entries()].find(([key]) => key.startsWith('auth/sessions/'))[1];
assert(JSON.parse(saved.body).expires <= peerUser.sessionExpiresAt);
const logout = await request('/auth/logout', { headers: { cookie: session } });
assert.equal(logout.headers.get('location'), peerOrigin + '/auth/logout?sso=return');
assert(logout.headers.getSetCookie().some(value => value.startsWith('__Host-mapa_sso_state=') && value.includes('Max-Age=0')));
assert.equal((await request('/api/session', { headers: { cookie: session } })).status, 401);
assert.equal((await request('/auth/logout?sso=return')).headers.get('location'), peerOrigin + '/login?sso=skip');
peerUser = { ...peerUser, email: 'person@motriz.org.br' };
flow = await begin();
assert((await (await flow.complete()).json()).redirect.startsWith('/login?sso=skip'));
peerUser = null; flow = await begin();
assert((await (await flow.complete()).json()).redirect.startsWith('/login?sso=skip'));
// The arrival must render without SSO, but its cleaned URL must retry on reload.
const login = await request('/login?sso=skip&return_to=%2F#access');
assert.equal(login.status, 200);
const html = await login.text();
const script = html.match(/<script nonce="([^"]+)">([^]*?)<\/script>/);
assert(script, 'Skipped login must clean its URL');
assert(login.headers.get('content-security-policy').includes("script-src 'nonce-" + script[1] + "'"));
let cleaned;
const state = { browserRouter: 'preserved' };
runInNewContext(script[2], { URL, location: { href: origin + '/login?sso=skip&return_to=%2F#access' }, history: { state, replaceState: (nextState, title, path) => { assert.equal(nextState, state); cleaned = path; } } });
assert.equal(cleaned, '/login?return_to=%2F#access');
assert.equal((await request(cleaned)).headers.get('location'), '/auth/sso/start');
peerUser = { userId: 'google:viewer', email: 'viewer@motriz.org', displayName: 'Pessoa', sessionExpiresAt: Date.now() + 3_600_000 };
flow = await begin();
const relogin = await flow.complete();
assert.equal((await relogin.json()).redirect, '/');
assert(relogin.headers.getSetCookie().some(value => value.startsWith('__Host-mapa_session=')), 'Reload must accept the new peer login');
console.log('PASS — integração Worker/R2, domínio exato, expiração, logout conjunto, recarregamento após novo login, papéis e consumo concorrente.');
