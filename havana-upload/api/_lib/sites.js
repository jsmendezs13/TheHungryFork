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
// The website's own address when it is one of ours (for links and QR codes), else ''.
export function siteHost(req) {
  const h = req && req.headers ? String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase().replace(/:\d+$/, '') : '';
  return HOSTS[h] ? h : '';
}
