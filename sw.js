// sw.js — r43 (Sebastian, 26 Oct): the notifications of the HF Staff app.
//
// This file only shows notifications and opens the manager page when one is
// tapped. It does not cache anything and never answers for the site's pages
// (there is no "fetch" handler), so the guests' pages work exactly as before.
//
// The message arrives sealed (Web Push, RFC 8291): only this browser can read
// it. It says { title, body, url, tag, kind }. The url is always a place on the
// manager page (/manager#chat=…, #reqchat=…, #request=…, #day=…, and for a
// change by the team #dish=… or #go=team|menu|settings); anything
// else opens the manager page itself.

const ICON = '/staff-icon-192.png';
const SAFE = /^\/manager(#(chat|reqchat|request|dish)=\d+(&at=\d+)?|#day=\d{4}-\d{2}-\d{2}(&b=\d+)?(&at=\d+)?|#go=(team|menu|settings)(&at=\d+)?)?$/;

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

function safeUrl(url) {
  const u = String(url || '');
  return SAFE.test(u) ? u : '/manager';
}

self.addEventListener('push', function (event) {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (e) { m = { body: event.data ? event.data.text() : '' }; }
  const title = String(m.title || 'HF Staff').slice(0, 80);
  const options = {
    body: String(m.body || '').slice(0, 200),
    icon: ICON,
    badge: ICON,
    tag: String(m.tag || m.kind || 'hf'),
    renotify: true,
    data: { url: safeUrl(m.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async function () {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // The manager page already open (the app, or a tab): it goes there by itself.
    for (const c of open) {
      if (new URL(c.url).pathname === '/manager') {
        try { await c.focus(); } catch (e) { /* some browsers refuse focus; the message still goes */ }
        c.postMessage({ hf: 'open', url: url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

// When the browser replaces a subscription (it does now and then), the manager
// page saves the new one the next time it opens (dvResync in manager.html).
