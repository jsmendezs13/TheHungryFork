export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code are required' });

  // Auto-format to E.164 (same as send-otp.js)
  phone = phone.replace(/\D/g, '');
  if (phone.length === 10) phone = '+1' + phone;
  else if (phone.length === 11 && phone.startsWith('1')) phone = '+' + phone;
  else if (!phone.startsWith('+')) phone = '+' + phone;

  try {
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: phone, Code: code }),
      }
    );
    const data = await response.json();
    if (data.status === 'approved') {
      return res.status(200).json({ success: true });
    } else {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
