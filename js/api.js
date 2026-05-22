// Tiny fetch wrapper for /api/* endpoints. Cookies (cl_session) ride along
// automatically since requests are same-origin.

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function request(method, path, body) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { 'Accept': 'application/json' },
    cache: 'no-store'
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (networkErr) {
    throw new ApiError(networkErr.message || 'network_error', 0, null);
  }

  const ct = res.headers.get('Content-Type') || '';
  let data = null;
  if (ct.includes('application/json')) {
    try { data = await res.json(); } catch { data = null; }
  } else {
    try { data = await res.text(); } catch { data = null; }
  }

  if (!res.ok) {
    const msg = (data && typeof data === 'object' && data.error)
      ? data.error
      : `${method} ${path} failed (${res.status})`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

export function apiGet(path) { return request('GET', path); }
export function apiPost(path, body) { return request('POST', path, body || {}); }
