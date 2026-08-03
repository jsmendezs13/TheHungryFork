import jwt from 'jsonwebtoken';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pkdwrjwsqrlfdxgqmpva.supabase.co';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { verificationTicket, phone_number, pin } = req.body;
  if (!verificationTicket || !phone_number || !pin) return res.status(400).json({ error: 'Missing required fields' });
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 6 digits' });

  // The ticket proves this exact phone number passed SMS verification minutes ago.
  let ticket;
  try {
    ticket = jwt.verify(verificationTicket, process.env.SUPABASE_JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Verification expired. Please verify your phone again.' });
  }
  if (ticket.purpose !== 'signup' || ticket.phone !== phone_number) {
    return res.status(401).json({ error: 'Verification does not match this phone number.' });
  }

  try {
    const updRes = await fetch(`${SUPABASE_URL}/rest/v1/tasters?phone_number=eq.${encodeURIComponent(phone_number)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ pin }),
    });
    const rows = await updRes.json();
    if (!updRes.ok || !rows.length) return res.status(404).json({ error: 'No account found with this phone number.' });

    const taster = rows[0];
    const session = jwt.sign(
      {
        role: 'authenticated',
        taster_id: taster.id,
        restaurant_id: taster.is_restaurant_admin ? taster.restaurant_id : null,
      },
      process.env.SUPABASE_JWT_SECRET,
      { expiresIn: '30d' }
    );
    delete taster.pin;
    return res.status(200).json({ success: true, session, taster });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
}
