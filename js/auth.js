import { apiGet, apiPost, ApiError } from './api.js';

// Thin wrapper around the /api/auth/* endpoints. All functions resolve to a
// uniform shape so callers don't have to special-case anything:
//   { ok: true,  data: ... }
//   { ok: false, error: <user-facing string> }

const ERROR_MESSAGES = {
  email_taken: 'That email is already registered. Try signing in.',
  invalid_credentials: 'Wrong email or password.',
  password_too_short: 'Password must be at least 6 characters.',
  password_too_long: 'Password is too long.',
  email_and_password_required: 'Email and password are required.',
  invalid_email: 'That email does not look right.',
  unauthorized: 'Please sign in.',
  payload_too_large: 'Request is too large.',
  network_error: 'You appear to be offline.',
  server_error: 'Server error. Try again in a moment.'
};

function describe(err) {
  if (!(err instanceof ApiError)) return err && err.message ? err.message : String(err);
  const code = (err.data && err.data.error) || err.message;
  if (ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  if (err.status === 0) return ERROR_MESSAGES.network_error;
  if (err.status >= 500) return ERROR_MESSAGES.server_error;
  return err.message || 'Something went wrong.';
}

export async function getSession() {
  try {
    const data = await apiGet('/api/auth/me');
    if (data && data.user) return { ok: true, data: { user: data.user } };
    return { ok: true, data: null };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { ok: true, data: null };
    }
    return { ok: false, error: describe(err) };
  }
}

export async function getUser() {
  const s = await getSession();
  if (!s.ok || !s.data) return null;
  return s.data.user || null;
}

export async function signUp(email, password) {
  try {
    const data = await apiPost('/api/auth/signup', { email, password });
    return { ok: true, data: { user: data.user } };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

export async function signIn(email, password) {
  try {
    const data = await apiPost('/api/auth/login', { email, password });
    return { ok: true, data: { user: data.user } };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

export async function signOut() {
  try {
    await apiPost('/api/auth/logout', {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}
