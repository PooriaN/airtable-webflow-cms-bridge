import crypto from 'crypto';
import type { Request, Response } from 'express';

export const SESSION_COOKIE_NAME = 'cmsb_session';
export const SESSION_VERSION = 'v1';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTOMATION_TOKEN_HEADER = 'x-cms-bridge-automation-token';

type AuthConfig = {
  password: string;
  sessionSecret: string;
};

type AutomationConfig = {
  token: string;
};

export function isProductionLike(): boolean {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
}

export function getAuthConfig(): AuthConfig | null {
  const password = process.env.APP_PASSWORD?.trim() || '';
  const sessionSecret = process.env.APP_SESSION_SECRET?.trim() || '';

  if (!password || !sessionSecret) {
    return null;
  }

  return { password, sessionSecret };
}

export function getAutomationConfig(): AutomationConfig | null {
  const token = process.env.APP_AUTOMATION_TOKEN?.trim() || '';
  if (!token) {
    return null;
  }
  return { token };
}

export function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};

  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return acc;
      const key = decodeURIComponent(part.slice(0, separator).trim());
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function createSessionToken(secret: string, issuedAt = Date.now()): string {
  const payload = `${SESSION_VERSION}.${issuedAt}`;
  const signature = signPayload(payload, secret);
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [version, issuedAtRaw, signature] = parts;
  if (version !== SESSION_VERSION) return false;

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return false;
  if (issuedAt > now + 5 * 60 * 1000) return false;
  if (now - issuedAt > SESSION_TTL_MS) return false;

  const expected = signPayload(`${version}.${issuedAtRaw}`, secret);
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function passwordMatches(candidate: string, password: string): boolean {
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  const passwordBuffer = Buffer.from(password, 'utf8');
  if (candidateBuffer.length !== passwordBuffer.length) return false;
  return crypto.timingSafeEqual(candidateBuffer, passwordBuffer);
}

export function tokenMatches(candidate: string, token: string): boolean {
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  const tokenBuffer = Buffer.from(token, 'utf8');
  if (candidateBuffer.length !== tokenBuffer.length) return false;
  return crypto.timingSafeEqual(candidateBuffer, tokenBuffer);
}

function shouldUseSecureCookies(req?: Request): boolean {
  if (!req) return isProductionLike();
  const forwardedProto = req.header('x-forwarded-proto');
  return forwardedProto === 'https' || req.secure || isProductionLike();
}

export function serializeSessionCookie(token: string, req?: Request): string {
  const secure = shouldUseSecureCookies(req) ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

export function serializeClearedSessionCookie(req?: Request): string {
  const secure = shouldUseSecureCookies(req) ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}

export function hasValidSession(req: Request, config: AuthConfig): boolean {
  const cookies = parseCookies(req.header('cookie'));
  return verifySessionToken(cookies[SESSION_COOKIE_NAME], config.sessionSecret);
}

export function hasValidAutomationToken(req: Request, config: AutomationConfig): boolean {
  const token = req.header(AUTOMATION_TOKEN_HEADER) || '';
  if (!token) return false;
  return tokenMatches(token, config.token);
}

export function isApiRequest(req: Request): boolean {
  return req.path.startsWith('/api/');
}

export function isAutomationSyncRequest(req: Request): boolean {
  return req.method === 'POST' && /^\/api\/sync\/[^/]+$/.test(req.path);
}

export function wantsHtml(req: Request): boolean {
  const accept = req.header('accept') || '';
  return accept.includes('text/html');
}

export function sendAuthUnavailable(res: Response, asJson: boolean): void {
  if (asJson) {
    res.status(503).json({ error: 'Authentication is not configured' });
    return;
  }

  res.status(503).type('html').send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Authentication Unavailable</title>
    <style>
      body { font-family: system-ui, sans-serif; background:#0a0a0f; color:#e4e4ef; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
      main { max-width:420px; padding:32px; border:1px solid #2a2a3a; border-radius:12px; background:#13131a; }
      h1 { margin-top:0; font-size:24px; }
      p { color:#a5a5bd; line-height:1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Authentication unavailable</h1>
      <p>This deployment is missing APP_PASSWORD or APP_SESSION_SECRET, so access is blocked until authentication is configured.</p>
    </main>
  </body>
</html>`);
}
