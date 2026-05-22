import { getSessionUser } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.status(200).json({ user: { id: user.sub, email: user.email } });
}
