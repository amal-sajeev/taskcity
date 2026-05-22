import { sql, ensureSchema } from '../_lib/db.js';
import { hashPassword } from '../_lib/hash.js';
import { signJwt, setSessionCookie, readJson } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    await ensureSchema();
    const body = await readJson(req);
    const email = String((body && body.email) || '').trim().toLowerCase();
    const password = String((body && body.password) || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'email_and_password_required' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'password_too_short' });
    }
    if (password.length > 200) {
      return res.status(400).json({ error: 'password_too_long' });
    }

    const existing = await sql`select id from users where email = ${email} limit 1`;
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'email_taken' });
    }

    const passwordHash = await hashPassword(password);
    const inserted = await sql`
      insert into users (email, password_hash)
      values (${email}, ${passwordHash})
      returning id, email
    `;
    const user = inserted.rows[0];

    const token = signJwt({ sub: user.id, email: user.email });
    setSessionCookie(req, res, token);
    return res.status(200).json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('signup error', err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
}
