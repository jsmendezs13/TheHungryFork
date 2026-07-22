import jwt from 'jsonwebtoken';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pkdwrjwsqrlfdxgqmpva.supabase.co';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const {
    verificationTicket,
    first_name,
    last_name,
    date_of_birth,
    gender,
    phone_number,
    pin,
    privacy_accepted,
    promotions_accepted,
  } = req.body;

  if (!verificationTicket) return res.status(400).json({ error: 'Missing verification ticket' });
  if (!first_name || !last_name || !date_of_birth || !gender || !phone_number || !pin) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Confirm the phone was actually OTP-verified moments ago, via Twilio.
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
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/tasters`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        first_name,
        last_name,
        date_of_birth,
        gender,
        phone_number,
        pin,
        privacy_accepted,
        promotions_accepted,
      }),
    });
    const inserted = await insertRes.json();
    if (!insertRes.ok) {
      const msg = JSON.stringify(inserted);
      if (msg.includes('unique')) {
        return res.status(409).json({ error: 'This phone number already has an account. Please log in instead.' });
      }
      return res.status(400).json({ error: 'Could not create account.' });
    }

    const taster = inserted[0];
    const session = jwt.sign(
      { role: 'authenticated', taster_id: taster.id, restaurant_id: null },
      process.env.SUPABASE_JWT_SECRET,
      { expiresIn: '30d' }
    );
    delete taster.pin;
    return res.status(200).json({ success: true, session, taster });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
}
