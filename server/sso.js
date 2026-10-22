function mapSSO(env) {
  return createSSOService({
    enabled: env.SITE_AUTH_MODE === 'oauth', origin: origin(env), peerOrigin: env.SSO_PEER_ORIGIN,
    secret: env.SSO_SHARED_SECRET, cookieName: '__Host-mapa_sso_state',
    getUser: request => sessionUser(request, env), allowed: user => permitted(user, env),
    createAttempt: async (id, attempt) => {
      await env.BUCKET.put('auth/sso/' + id, JSON.stringify(attempt), { httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
    },
    takeAttempt: async id => {
      const key = 'auth/sso/' + id, object = await env.BUCKET.get(key);
      if (!object) return null;
      const attempt = await object.json();
      if (attempt.consumed) return null;
      const used = await env.BUCKET.put(key, JSON.stringify({ ...attempt, consumed: true }), { onlyIf: { etagMatches: object.etag }, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
      return used ? attempt : null;
    },
    issueSession: async user => {
      const token = random(), expires = Math.min(user.sessionExpiresAt, Date.now() + SESSION_LIFETIME * 1000);
      await env.BUCKET.put('auth/sessions/' + await digest(token), JSON.stringify({ user: { userId: user.userId, email: user.email, displayName: user.displayName }, expires }), { httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
      return cookie(SESSION_COOKIE, token, Math.max(1, Math.floor((expires - Date.now()) / 1000)));
    },
  });
}
