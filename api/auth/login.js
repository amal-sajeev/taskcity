import { sql, ensureSchema } from '../_lib/db.js';
import { verifyPassword } from '../_lib/hash.js';
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

    const { rows } = await sql`
      select id, email, password_hash from users where email = ${email} limit 1
    `;
    const row = rows[0];

    // Compare against a dummy hash even when the user doesn't exist so the
    // response time is roughly constant and doesn't leak whether the email
    // exists in the DB.
    const dummy = 'scrypt$16384$' + '00'.repeat(16) + '$' + '00'.repeat(64);
    const stored = row ? row.password_hash : dummy;
    const ok = await verifyPassword(password, stored);

    if (!row || !ok) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const token = signJwt({ sub: row.id, email: row.email });
    setSessionCookie(req, res, token);
    return res.status(200).json({ user: { id: row.id, email: row.email } });
  } catch (err) {
    console.error('login error', err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
}
