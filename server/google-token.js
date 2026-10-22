// Verificador Google compartilhado com a agenda institucional.




const jwksCache = new Map                                                            ();

const keysUrls                                = {
  google: "https://www.googleapis.com/oauth2/v3/certs",
};

function decode(part        )             {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("Invalid token encoding");
  return Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
}

function object(part        )                          {
  const data          = JSON.parse(new TextDecoder().decode(decode(part)));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid token data");
  return data                           ;
}

async function loadKeys(provider               )                {
  const cached = jwksCache.get(provider);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    const response = await fetch(keysUrls[provider]);
    if (!response.ok) throw new Error("Signing keys unavailable");
    const value          = await response.json();
    if (!value || typeof value !== "object" || !Array.isArray((value        ).keys)) throw new Error("Invalid signing keys");
    return value        ;
  })();
  jwksCache.set(provider, { expires: Date.now() + 5 * 60_000, promise });
  promise.catch(() => jwksCache.delete(provider));
  return promise;
}

async function verifyIdentityToken(
  token        ,
  provider               ,
  audience        ,
  nonce        ,
  allowedDomains           = [],
  getKeys                                             = loadKeys,
)                                                                         {
  if (provider !== "google" || !audience || !nonce || !token || token.length > 16_384) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = object(encodedHeader);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const jwks = await getKeys(provider);
    const candidate = jwks.keys.find((key) => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
    if (!candidate) return null;
    const publicKey = await crypto.subtle.importKey("jwk", candidate, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, new Uint8Array(decode(encodedSignature)), signed)) return null;

    const claims = object(encodedClaims);
    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== audience || claims.nonce !== nonce || typeof claims.sub !== "string" || !claims.sub ||
      typeof claims.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) ||
      typeof claims.exp !== "number" || claims.exp <= now || typeof claims.iat !== "number" || claims.iat > now + 60 ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now))) return null;
    const email = claims.email.trim().toLowerCase();
    if (!["https://accounts.google.com", "accounts.google.com"].includes(String(claims.iss)) || claims.email_verified !== true) return null;
    if (allowedDomains.length && (typeof claims.hd !== "string" ||
      !allowedDomains.includes(claims.hd.toLowerCase()) || claims.hd.toLowerCase() !== email.split("@")[1])) return null;
    const userId = `google:${claims.sub}`;
    return { userId, email, displayName: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : email };
  } catch {
    return null;
  }
}
