import jwt from 'jsonwebtoken';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pkdwrjwsqrlfdxgqmpva.supabase.co';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: 'Phone and PIN are required' });
  phone = phone.replace(/\D/g, '');
  if (phone.length === 10) phone = '+1' + phone;
  else if (phone.length === 11 && phone.startsWith('1')) phone = '+' + phone;
  else if (!phone.startsWith('+')) phone = '+' + phone;

  try {
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tasters?phone_number=eq.${encodeURIComponent(phone)}&select=*`,
      {
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
      }
    );
    const rows = await lookupRes.json();
    if (!lookupRes.ok || !rows.length) return res.status(401).json({ error: 'Phone number not found.' });
    const taster = rows[0];
    if (taster.pin !== pin) return res.status(401).json({ error: 'Incorrect PIN. Please try again.' });

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
