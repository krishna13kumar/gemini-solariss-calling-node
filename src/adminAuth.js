/**
 * Password gate for the admin dashboard and every API behind it.
 *
 * The password is ADMIN_PASSWORD from .env and is checked on the server against what the person typed
 * (never sent to or compared in the browser). A correct password sets a random, HttpOnly session cookie
 * that is kept in memory, so a server restart logs everyone out. If ADMIN_PASSWORD is unset the admin
 * area stays locked rather than open.
 */

import crypto from 'node:crypto';
import { getEnv } from './env.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;            // wrong passwords per IP...
const FAILURE_WINDOW_MS = 10 * 60 * 1000; // ...within this window lock that IP out until it passes

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function createAdminAuth() {
  const sessions = new Map();  // token -> expiry (ms)
  const failures = new Map();  // ip -> [timestamps of recent wrong passwords]

  const password = () => getEnv('ADMIN_PASSWORD', '');

  const cookieToken = (req) => /(?:^|;\s*)admin_sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1] ?? null;

  function isAuthed(req) {
    const token = cookieToken(req);
    const exp = token && sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(token); return false; }
    return true;
  }

  const recentFailures = (ip) => {
    const fresh = (failures.get(ip) || []).filter(t => Date.now() - t < FAILURE_WINDOW_MS);
    failures.set(ip, fresh);
    return fresh;
  };

  /** @returns {{ok: true, cookie: string} | {ok: false, status: number, error: string, retryAfter?: number}} */
  function login(req, typed) {
    const expected = password();
    if (!expected) return { ok: false, status: 503, error: 'Admin access is not set up: add ADMIN_PASSWORD to the .env file and restart.' };

    const recent = recentFailures(req.ip);
    if (recent.length >= MAX_FAILURES) {
      return { ok: false, status: 429, error: 'Too many wrong attempts. Try again in a few minutes.', retryAfter: Math.ceil((FAILURE_WINDOW_MS - (Date.now() - recent[0])) / 1000) };
    }
    // Equal-length digests so the comparison takes the same time whatever was typed.
    if (typeof typed !== 'string' || !crypto.timingSafeEqual(sha(typed), sha(expected))) {
      recent.push(Date.now());
      return { ok: false, status: 401, error: 'Wrong password.' };
    }
    failures.delete(req.ip);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + SESSION_MS);
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    return { ok: true, cookie: `admin_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}` };
  }

  function logout(req) {
    const token = cookieToken(req);
    if (token) sessions.delete(token);
    return 'admin_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
  }

  return { isAuthed, login, logout, isConfigured: () => !!password() };
}

/** Paths that need an admin session. Everything not listed stays public (the entry page, the call socket, Exotel's webhook). */
export function requiresAdmin(method, url) {
  const p = url.split('?')[0];
  if (p.startsWith('/api/admin/')) return false;              // login / logout / session check
  if (p.startsWith('/api/')) return true;                     // every dashboard API
  if (p === '/telephony/trigger-campaign') return true;       // starts real calls
  if (p === '/ws/live-feed' || p === '/ws/chat') return true; // live transcripts and the text chat
  if (p.startsWith('/admin/') && p !== '/admin/') return true; // dashboard scripts/styles (the /admin page itself shows the login form)
  return false;
}
