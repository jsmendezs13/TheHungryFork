// sites.js — which restaurant a website address belongs to (Havana Social, 19 Nov 2026).
// The same list as /site.js (the pages). One Vercel project serves every restaurant's website;
// the address the guest typed says which one. Used only when a request doesn't say its restaurant.
const HOSTS = {
  'thehungryfork.fun': 1, 'www.thehungryfork.fun': 1,
  'havana-social.vercel.app': 2, 'havanasocialnyc.com': 2, 'www.havanasocialnyc.com': 2,
};
export function siteRestaurant(req) {
  const h = req && req.headers ? String(req.headers['x-forwarded-host'] || req.headers.host || '') : '';
  return HOSTS[h.toLowerCase().replace(/:\d+$/, '')] || 1;
}
// r60 (24 Nov 2026, Sebastian: "they need to be separate"): the restaurant whose website this request comes from,
// so each website shows and runs only its own restaurant (the Manager page, the bell, the messages, the login code).
// One of our addresses says it. Anywhere else (the test bench, a preview address) the page says it: site.js sends
// X-HF-Site with every request. null when nobody says (an old page, a script): then nothing is narrowed.
// It only ever narrows: what a person may do still comes from their roles (roles.js).
export function siteScope(req) {
  const h = req && req.headers ? String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase().replace(/:\d+$/, '') : '';
  if (HOSTS[h]) return HOSTS[h];
  const v = Number(req && req.headers ? req.headers['x-hf-site'] : NaN);
  return Number.isInteger(v) && v > 0 && v < 100000 ? v : null;
}
// The website's own address when it is one of ours (for links and QR codes), else ''.
export function siteHost(req) {
  const h = req && req.headers ? String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase().replace(/:\d+$/, '') : '';
  return HOSTS[h] ? h : '';
}
