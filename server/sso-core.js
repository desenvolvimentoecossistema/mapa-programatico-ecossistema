// Shared between the two institutional Sites. Secrets never enter browser code.

function createSSOService(options) {

  const ttl = 120_000;

  const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

  const encode = value => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const bytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));

  const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('');

  function httpsOrigin(value) {

    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null; } catch { return null; }

  }

  const origin = httpsOrigin(options.origin), peer = httpsOrigin(options.peerOrigin);

  const enabled = Boolean(options.enabled && origin && peer && origin !== peer && /^[A-Za-z0-9_-]{43,128}$/.test(options.secret || ''));

  const safeReturn = value => {

    try { const url = new URL(value || '/', origin); return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && url.origin === origin && !url.pathname.startsWith('/auth/') && url.pathname !== '/login' ? url.pathname + url.search + url.hash : '/'; } catch { return '/'; }

  };

  const skipPath = value => '/login?sso=skip&return_to=' + encodeURIComponent(safeReturn(value));

  // Both destinations are fixed configuration values, never caller-supplied URLs.

  const logoutTarget = returning => enabled ? new URL(returning ? '/login?sso=skip' : '/auth/logout?sso=return', peer).href : '/login?sso=skip';

  const stateCookie = (value, age = 120) => `${options.cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;

  const cookieValue = request => {

    const values = (request.headers.get('cookie') || '').split(';').map(x => x.trim()).filter(x => x.startsWith(options.cookieName + '='));

    return values.length === 1 ? values[0].slice(options.cookieName.length + 1) : '';

  };

  function redirect(location, cookie) {

    const headers = new Headers({ location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });

    if (cookie) headers.append('set-cookie', cookie);

    return new Response(null, { status: 303, headers });

  }

  function result(path, cookie) {

    const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });

    headers.append('set-cookie', stateCookie('', 0));

    if (cookie) headers.append('set-cookie', cookie);

    return Response.json({ redirect: path }, { headers });

  }

  const key = () => crypto.subtle.importKey('raw', new TextEncoder().encode(options.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

  async function sign(payload) {

    const body = encode(payload);

    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(), new TextEncoder().encode(body)));

    return body + '.' + btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  }

  async function verify(assertion) {

    if (typeof assertion !== 'string' || assertion.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(assertion)) return null;

    try {

      const [body, signature] = assertion.split('.');

      if (!await crypto.subtle.verify('HMAC', await key(), bytes(signature), new TextEncoder().encode(body))) return null;

      const payload = JSON.parse(new TextDecoder().decode(bytes(body))), now = Date.now();

      if (payload.iss !== peer || payload.aud !== origin || !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.iat > now + 10_000 || payload.exp <= now || payload.exp - payload.iat > 60_000) return null;

      const user = payload.user;

      if (!user || typeof user.userId !== 'string' || !user.userId.startsWith('google:') || typeof user.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) || typeof user.displayName !== 'string' || user.displayName.length > 1024 || !Number.isFinite(user.sessionExpiresAt) || user.sessionExpiresAt <= now || !await options.allowed(user)) return null;

      return payload;

    } catch { return null; }

  }

  async function readJSON(request) {

    if (!request.body) throw Error('Missing body');

    const reader = request.body.getReader(), chunks = [];

    let length = 0;

    while (true) {

      const { done, value } = await reader.read(); if (done) break;

      length += value.length; if (length > 12_000) { await reader.cancel(); throw Error('Body too large'); } chunks.push(value);

    }

    const data = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }

    return JSON.parse(new TextDecoder().decode(data));

  }

  async function handle(request) {

    const url = new URL(request.url), path = url.pathname;

    if (!path.startsWith('/auth/sso/')) return null;

    if (!enabled) return new Response('Login integrado indisponível.', { status: 404 });

    if (url.origin !== origin) return new Response('Origem inválida.', { status: 400 });

    if (path === '/auth/sso/start' && request.method === 'GET') {

      const returnTo = safeReturn(url.searchParams.get('return_to') || '/');

      if (await options.getUser(request)) return redirect(returnTo);

      const state = random(), nonce = random();

      await options.createAttempt(await hash(state), { nonce, returnTo, expiresAt: Date.now() + ttl });

      const next = new URL('/auth/sso/authorize', peer); next.search = new URLSearchParams({ state, nonce }).toString();

      return redirect(next.href, stateCookie(state));

    }

    if (path === '/auth/sso/authorize' && request.method === 'GET') {

      const state = url.searchParams.get('state'), nonce = url.searchParams.get('nonce');

      if (!tokenPattern.test(state || '') || !tokenPattern.test(nonce || '')) return new Response('Solicitação inválida.', { status: 400 });

      const user = await options.getUser(request), target = new URL('/auth/sso/callback', peer);

      const fragment = new URLSearchParams({ state });

      if (user && Number.isFinite(user.sessionExpiresAt) && user.sessionExpiresAt > Date.now()) {

        const identity = { userId: user.userId, email: user.email, displayName: user.displayName || user.email, sessionExpiresAt: user.sessionExpiresAt };

        fragment.set('assertion', await sign({ iss: origin, aud: peer, state, nonce, iat: Date.now(), exp: Date.now() + 60_000, user: identity }));

      }

      // The signed identity is in the fragment, so it is absent from HTTP URLs and referrers.

      target.hash = fragment.toString(); return redirect(target.href);

    }

    if (path === '/auth/sso/callback' && request.method === 'GET') {

      const nonce = random();

      const script = `(async()=>{const data=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);try{const response=await fetch('/auth/sso/complete',{method:'POST',credentials:'same-origin',signal:AbortSignal.timeout(12000),headers:{'content-type':'application/json'},body:JSON.stringify({state:data.get('state'),assertion:data.get('assertion')})});const result=await response.json();const path=result.redirect;if(!response.ok||typeof path!=='string'||!path.startsWith('/')||path.startsWith('//'))throw Error();location.replace(path);}catch{location.replace('/login?sso=skip');}})();`;

      const styles = `*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}body{min-height:100dvh;display:grid;place-items:center;background:#052B47}.spinner{display:block;width:48px;height:48px;border:4px solid #ffffff30;border-top-color:#BDCF3A;border-radius:50%;animation:spin .8s linear infinite}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}`;

      return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectando ao Ecossistema</title><style nonce="${nonce}">${styles}</style></head><body><main role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Conectando ao Ecossistema…</span></main><script nonce="${nonce}">${script}</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` } });

    }

    if (path === '/auth/sso/complete' && request.method === 'POST') {

      if (request.headers.get('origin') !== origin || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return new Response('Origem inválida.', { status: 403 });

      try {

        const body = await readJSON(request), browserState = cookieValue(request);

        if (!tokenPattern.test(browserState) || body.state !== browserState) return result(skipPath('/'));

        const attempt = await options.takeAttempt(await hash(browserState));

        if (!attempt || attempt.expiresAt <= Date.now()) return result(skipPath('/'));

        const payload = await verify(body.assertion);

        if (!payload || payload.state !== browserState || payload.nonce !== attempt.nonce) return result(skipPath(attempt.returnTo));

        const cookie = await options.issueSession(payload.user);

        return result(safeReturn(attempt.returnTo), cookie);

      } catch { return result(skipPath('/')); }

    }

    return new Response('Método ou rota indisponível.', { status: 405 });

  }

  return { enabled, handle, skipPath, logoutTarget };

}

