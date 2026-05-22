import crypto from 'node:crypto';

// HS256 JWT signing + verification using only Node built-ins. The token lives
// in an HttpOnly cookie so the browser never has to touch it directly.

const COOKIE_NAME = 'cl_session';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error('JWT_SECRET env var is required (set to a 32+ char random string).');
  }
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export function signJwt(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + COOKIE_MAX_AGE };
  const h = b64url(JSON.stringify(header));
  const b = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', getSecret()).update(`${h}.${b}`).digest();
  return `${h}.${b}.${b64url(sig)}`;
}

export function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  let expected;
  try {
    expected = crypto.createHmac('sha256', getSecret()).update(`${h}.${b}`).digest();
  } catch {
    return null;
  }
  const actual = b64urlDecode(s);
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(b).toString('utf8'));
    if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readCookie(req, name) {
  const header = req.headers && req.headers.cookie ? req.headers.cookie : '';
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); }
      catch { return part.slice(eq + 1).trim(); }
    }
  }
  return null;
}

function isHttps(req) {
  const xfp = req.headers && req.headers['x-forwarded-proto'];
  if (xfp && String(xfp).includes('https')) return true;
  return Boolean(req.connection && req.connection.encrypted);
}

export function setSessionCookie(req, res, token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE}`
  ];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req, res) {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function getSessionUser(req) {
  const token = readCookie(req, COOKIE_NAME);
  return verifyJwt(token);
}

export function requireUser(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return user;
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let data = '';
  for await (const chunk of req) {
    data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (data.length > 1024 * 1024 * 4) throw new Error('payload_too_large');
  }
  try { return data ? JSON.parse(data) : {}; }
  catch { return {}; }
}
