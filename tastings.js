// tastings.js — My Tastings, the same on the home page and the menu page (r62, 24 Nov 2026).
//
// Sebastian, 08:38: "redesign this, I don't like how it looks … and you didn't add Edit" → he chose design C:
// each dish a card — a big photo in a pale circle, the name, the stars and the number, the restaurant, the date
// ("Edited" when it was), the words in a white box, and two wide buttons, Edit and Delete. The heart (save a dish) stays.
// Edit (migration 45): the author changes the five scores and the two comments (api/_lib/reviewedit.js); the earlier
// version is kept privately. A dish rated at another restaurant shows with its own name, photo and restaurant, and opens
// that restaurant's menu (r60). Each page keeps its own loadMyTastings(), which calls hfLoadTastings({ open }).
(function () {
  var css = ''
    + '.review-item.tc-card{display:block;background:#F7F3EC;border:1px solid rgba(43,33,26,.08);border-radius:18px;padding:14px;margin:0;position:relative;}'   // over the old row (.tasting-item flex, the red edge)
    + '.tc-card.tc-tap{cursor:pointer;}'
    + '.tc-top{display:flex;gap:14px;align-items:center;}'
    + '.tc-ph{width:96px;height:96px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;background:radial-gradient(#fff 55%,#F1E9DE);overflow:hidden;}'
    + '.tc-ph img.tasting-thumb{width:86px;height:72px;object-fit:contain;margin:0;border-radius:0;}'
    + '.tc-ph .tasting-thumb-emoji{width:86px;height:72px;font-size:2.2rem;background:none;margin:0;}'
    + '.tc-info{flex:1;min-width:0;}'
    + '.tc-row1{display:flex;align-items:flex-start;justify-content:space-between;gap:6px;}'
    + '.tc-card .reviewer-name{font-weight:800;font-size:1.02rem;line-height:1.2;color:var(--dark,#2B211A);}'
    + '.tc-card .pin-btn{margin:0;}'
    + '.tc-stars{display:flex;align-items:center;gap:6px;margin:4px 0 2px;}'
    + '.tc-stars .fsr{height:16px;width:auto;}'
    + '.tc-stars svg{height:16px;width:auto;}'
    + '.tc-stars b{font-size:.86rem;}'
    + '.tc-card .tasting-place{font-size:.84rem;margin:0;}'
    + '.tc-when{font-size:.76rem;color:#8A7B6E;}'
    + '.tc-edited{font-style:italic;}'
    + '.tc-words{margin-top:10px;padding:9px 12px;background:#fff;border:1px solid rgba(43,33,26,.08);border-radius:12px;font-size:.86rem;line-height:1.45;color:#3B342E;white-space:pre-line;overflow-wrap:anywhere;}'
    + '.tc-words + .tc-words{margin-top:6px;}'
    + '.tc-words small{display:block;font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;color:#8A7B6E;margin-bottom:2px;}'
    + '.tc-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;}'
    + '.tc-btns .hf-del-row{margin:0;display:block;}'
    + '.tc-btns .hf-del-btn,.tc-edit{width:100%;justify-content:center;display:inline-flex;align-items:center;gap:.4rem;border-radius:999px;padding:.55rem .5rem;font-family:var(--sans,system-ui);font-weight:700;font-size:.82rem;cursor:pointer;background:#fff;}'
    + '.tc-edit{border:1.5px solid #B01015;color:#B01015;}'
    + '.tc-btns .hf-del-btn{border:1.5px solid #D9CFC2;color:#6B5F55;}'
    + '.tc-edit svg,.tc-btns .hf-del-btn svg{width:14px;height:14px;}'
    + '.tc-btns.one{grid-template-columns:1fr;}'
    + 'html[data-site="havana"] .review-item.tc-card{background:#F5FAFE;border-color:#E3EEF5;}'
    + 'html[data-site="havana"] .tc-ph{background:radial-gradient(#fff 55%,#E2F3FC);}'
    + 'html[data-site="havana"] .tc-card .reviewer-name{color:#16203A;}'
    + 'html[data-site="havana"] .tc-words{border-color:#E3EEF5;color:#3B4456;}'
    + 'html[data-site="havana"] .tc-when,html[data-site="havana"] .tc-words small{color:#7C8595;}'
    + 'html[data-site="havana"] .tc-edit{border-color:#2D0077;color:#2D0077;}'
    + 'html[data-site="havana"] .tc-btns .hf-del-btn{border-color:#C9CFD8;color:#5A6478;}'
    // the Edit window
    + '.tce-over{position:fixed;inset:0;z-index:4000;background:rgba(10,8,6,.55);display:flex;align-items:center;justify-content:center;padding:16px;}'
    + '.tce-over[hidden]{display:none;}'
    + '.tce-box{background:#fff;border-radius:20px;width:100%;max-width:460px;max-height:calc(100svh - 32px);overflow:auto;box-shadow:0 20px 50px rgba(0,0,0,.35);}'
    + '.tce-hd{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #EEE6DC;position:sticky;top:0;background:#fff;z-index:1;}'
    + '.tce-hd h3{font-size:1.05rem;margin:0;}'
    + '.tce-x{background:none;border:0;font-size:1.2rem;cursor:pointer;padding:4px 8px;}'
    + '.tce-bd{padding:12px 18px 18px;}'
    + '.tce-dish{font-weight:800;margin-bottom:2px;}'
    + '.tce-note{font-size:.78rem;color:#8A7B6E;margin-bottom:10px;}'
    + '.tce-grp{margin-top:12px;}'
    + '.tce-grp h4{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:#8A7B6E;margin:0 0 6px;}'
    + '.tce-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0;}'
    + '.tce-row span{font-size:.88rem;}'
    + '.tce-stars{display:flex;gap:2px;}'
    + '.tce-stars button{background:none;border:0;padding:2px;cursor:pointer;line-height:0;}'
    + '.tce-stars svg{width:28px;height:28px;}'
    + '.tce-stars button path{fill:#E4D9C9;}'
    + '.tce-stars button.on path{fill:#F2B705;}'
    + '.tce-bd textarea{width:100%;min-height:72px;margin-top:6px;border:1px solid #DDD3C7;border-radius:12px;padding:9px 11px;font:inherit;font-size:.9rem;resize:vertical;}'
    + '.tce-err{color:#B01015;font-size:.82rem;margin-top:8px;}'
    + '.tce-err:empty{display:none;}'
    + '.tce-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;}'
    + '.tce-btns button{border-radius:999px;padding:.75rem .5rem;font-weight:800;font-size:.84rem;cursor:pointer;font-family:var(--sans,system-ui);}'
    + '.tce-save{background:#B01015;color:#fff;border:1.5px solid #B01015;}'
    + '.tce-save[disabled]{opacity:.6;}'
    + '.tce-cancel{background:#fff;color:#2B211A;border:1.5px solid #D9CFC2;}'
    + 'html[data-site="havana"] .tce-save{background:#2D0077;border-color:#2D0077;}'
    + 'html[data-site="havana"] .tce-stars button.on path{fill:#F6C915;}'
    + '.tce-words{background:#F7F3EC;border-radius:12px;padding:9px 12px;font-size:.88rem;margin:4px 0 8px;white-space:pre-line;overflow-wrap:anywhere;}'   // r63
    + 'html[data-site="havana"] .tce-words{background:#F5FAFE;}'
    + '.tce-save.tce-del{background:#B01015;border-color:#B01015;}';
  try { var s = document.createElement('style'); s.id = 'hf-tastings-css'; s.textContent = css; (document.head || document.documentElement).appendChild(s); } catch (e) {}
})();

var HF_TC = { rows: {} };                            // the reviews on screen, by id (the Edit window starts from them)
var HF_TC_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
var HF_TC_GROUPS = [
  { title: 'About the dish', comment: 'dish_comment', rows: [['flavor', 'Flavor'], ['worth_every_bite', 'Worth Every Bite'], ['signature_style', 'Signature Style']] },
  { title: 'About the restaurant', comment: 'restaurant_comment', rows: [['hospitality', 'Hospitality'], ['atmosphere_vibe', 'Atmosphere & Vibe']] }
];

// a dish of another restaurant opens on that restaurant's own website (the test bench: ?site= on this one)
function tastingAwayLink(rid, slug) {
  var key = window.HF_SITE_KEYS && HF_SITE_KEYS[rid];
  var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (local && key) return '/menu?site=' + encodeURIComponent(key) + '&dish=' + encodeURIComponent(slug);
  var site = HF_TASTE && HF_TASTE.restaurants[rid] && HF_TASTE.restaurants[rid].site;
  return site ? site + '/menu?dish=' + encodeURIComponent(slug) : null;
}
function hfTcDate(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function hfTcStars(score) {
  if (typeof forkStarRow === 'function') return forkStarRow(score);
  var n = Math.round(Number(score) || 0), out = '';
  for (var i = 0; i < 5; i++) out += i < n ? '★' : '☆';
  return out;
}

async function hfLoadTastings(opts) {
  opts = opts || {};
  var list = document.getElementById('tastings-list');
  if (!list) return;
  list.innerHTML = '<div class="no-reviews">Loading…</div>';
  try {
    await hfTalksLoad().catch(function () { return null; });
    var got = await hfKept(sbFetch, '/rest/v1/reviews?taster_id=eq.' + currentTaster.id + '&select=*&order=created_at.desc');
    var data = got.data;
    if (!got.ok || !data.length) { list.innerHTML = '<div class="no-reviews">No tastings yet — go rate a dish!</div>'; return; }
    var pins = typeof getPins === 'function' ? getPins() : [];
    var hid = data.some(function (r) { return r.hidden_at; }) ? await hfMyHidden(true) : {};
    hfHiddenSeen();
    if (!DISHES.length && typeof HF_DISHES_P !== 'undefined' && HF_DISHES_P) await HF_DISHES_P.catch(function () { return null; });
    var T = HF_TASTE || { dishes: {}, restaurants: {} };
    var siteId = (window.HF_SITE && HF_SITE.id) || 1;
    var rows = data.map(function (r) {
      var score = ((r.flavor + r.worth_every_bite + r.signature_style) / 3).toFixed(1);
      var here = r.restaurant_id == null || Number(r.restaurant_id) === Number(siteId);
      var dishEntry = here ? Object.entries(DISH_ID_MAP).find(function (e) { return e[1] === r.dish_id; }) : null;
      var known = dishEntry ? DISHES.find(function (d) { return d.id === dishEntry[0]; }) : null;
      var far = T.dishes[r.dish_id] || null;
      var dishInfo = known || (far ? { name: far.name, img: far.img, emoji: far.emoji || '🍽️' } : null);
      var dishId = dishEntry ? dishEntry[0] : null;
      var place = (T.restaurants[r.restaurant_id] && T.restaurants[r.restaurant_id].name) || (here ? ((window.HF_SITE && HF_SITE.name) || 'The restaurant') : 'Another restaurant');
      var away = !dishId && far && far.slug ? tastingAwayLink(r.restaurant_id, far.slug) : null;
      return { r: r, score: score, dishInfo: dishInfo, dishId: dishId, place: place, away: away, pinned: !!(dishId && pins.indexOf(dishId) >= 0) };
    });
    rows.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
    HF_TC.rows = {}; HF_TC.open = opts.open || null;
    list.innerHTML = rows.map(function (x) {
      var r = x.r, d = x.dishInfo;
      HF_TC.rows[r.id] = { r: r, name: d ? d.name : ('Dish #' + r.dish_id), place: x.place };
      var rawName = d ? d.name : ('Dish #' + r.dish_id), dishName = hfEsc(rawName);
      var click = x.dishId ? ' onclick="hfTcOpen(\'' + x.dishId + '\')"' : x.away ? ' onclick="window.location.href=this.dataset.away" data-away="' + hfEsc(x.away) + '"' : '';
      var thumb = d && d.img
        ? '<img class="tasting-thumb" src="' + hfImgSrc(d.img, 96) + '" data-orig="' + hfEsc(d.img) + '" alt="" onerror="tastingThumbErr(this,\'' + (d.emoji || '🍽️') + '\')">'
        : '<div class="tasting-thumb tasting-thumb-emoji">' + (d ? d.emoji : '🍽️') + '</div>';
      var pin = x.dishId && typeof PIN_SVG !== 'undefined' ? '<button class="pin-btn' + (x.pinned ? ' pinned' : '') + '" onclick="togglePin(event,\'' + x.dishId + '\')" title="Save this dish" aria-label="Save this dish">' + PIN_SVG + '</button>' : '';
      var talk = !r.hidden_at || (hid[r.id] && hid[r.id].team)
        ? (HF_TALKS[r.id] ? '<div onclick="event.stopPropagation()">' + hfTalkButton(r.id, 'Messages with ' + x.place) + '<div class="hf-talk" id="hf-talk-' + r.id + '" hidden></div></div>' : '') : '';
      var del = HF_TALK_READY === true ? hfDeleteButton(r.id, JSON.stringify({ dish: rawName, img: d && d.img ? hfImgSrc(d.img, 96) : null, score: Number(x.score),
        date: new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) })) : '';
      var edit = HF_EDIT_READY === true ? '<button type="button" class="tc-edit" data-edit="' + Number(r.id) + '" onclick="event.stopPropagation();hfTcEdit(' + Number(r.id) + ')">' + HF_TC_PENCIL + 'Edit</button>' : '';
      var words = (r.dish_comment ? '<div class="tc-words">' + (r.restaurant_comment ? '<small>About the dish</small>' : '') + hfEsc(r.dish_comment) + '</div>' : '')
        + (r.restaurant_comment ? '<div class="tc-words"><small>About the restaurant</small>' + hfEsc(r.restaurant_comment) + '</div>' : '');
      return '<div class="review-item tasting-item tc-card' + (click ? ' tc-tap' : '') + '" data-review="' + Number(r.id) + '"' + click + '>'
        + '<div class="tc-top"><div class="tc-ph">' + thumb + '</div><div class="tc-info">'
        + '<div class="tc-row1"><span class="reviewer-name">' + dishName + '</span>' + pin + '</div>'
        + '<div class="tc-stars">' + hfTcStars(x.score) + '<b>' + x.score + '</b></div>'
        + '<div class="review-text brand-red-text tasting-place">' + hfEsc(x.place) + '</div>'
        + '<div class="tc-when">' + hfTcDate(r.created_at) + (r.edited_at ? ' · <span class="tc-edited">Edited</span>' : '') + '</div>'
        + '</div></div>'
        + words
        + (r.hidden_at ? hfHiddenNote(hid[r.id], r.restaurant_id, r.id) : hfWaiting(r) ? hfWaitNote(r) : '')
        + talk
        + (edit || del ? '<div class="tc-btns' + (edit && del ? '' : ' one') + '">' + edit + del + '</div>' : '')
        + '</div>';
    }).join('');
    if (typeof HF_TALK_AT !== 'undefined' && HF_TALK_AT && document.getElementById('hf-talk-' + HF_TALK_AT)) hfTalkToggle(HF_TALK_AT, true);
    if (typeof HF_TALK_AT !== 'undefined') HF_TALK_AT = null;
  } catch (e) {
    list.innerHTML = '<div class="no-reviews">Could not load your tastings.</div>';
  }
}
function hfTcOpen(dishId) { if (HF_TC.open) HF_TC.open(dishId); }

// ── the Edit window ──
function hfTcEdit(id) {
  var it = HF_TC.rows[id]; if (!it) return;
  var r = it.r, over = document.getElementById('tce-over');
  if (!over) { over = document.createElement('div'); over.id = 'tce-over'; over.className = 'tce-over'; over.setAttribute('role', 'dialog'); over.setAttribute('aria-modal', 'true');
    over.addEventListener('click', function (e) { if (e.target === over) hfTcEditClose(); }); document.body.appendChild(over); }
  HF_TC.edit = { id: id, scores: {} };
  var star = '<svg viewBox="0 0 100 100"><path d="M50 4 L62 38 L98 38 L69 60 L80 95 L50 73 L20 95 L31 60 L2 38 L38 38 Z"/></svg>';
  var html = '<div class="tce-box"><div class="tce-hd"><h3>Edit your rating</h3><button type="button" class="tce-x" aria-label="Close" onclick="hfTcEditClose()">✕</button></div><div class="tce-bd">'
    + '<div class="tce-dish">' + hfEsc(it.name) + ' · ' + hfEsc(it.place) + '</div>'
    + '<div class="tce-note">Your rating keeps its date and shows “Edited”. The earlier version is kept privately.</div>';
  HF_TC_GROUPS.forEach(function (g) {
    html += '<div class="tce-grp"><h4>' + g.title + '</h4>';
    g.rows.forEach(function (k) {
      var v = Number(r[k[0]]) || 0; HF_TC.edit.scores[k[0]] = v || null;
      html += '<div class="tce-row"><span>' + k[1] + '</span><div class="tce-stars" data-k="' + k[0] + '" role="radiogroup" aria-label="' + k[1] + '">';
      for (var i = 1; i <= 5; i++) html += '<button type="button" class="' + (i <= v ? 'on' : '') + '" data-v="' + i + '" aria-label="' + i + ' star' + (i > 1 ? 's' : '') + '" onclick="hfTcStar(\'' + k[0] + '\',' + i + ')">' + star + '</button>';
      html += '</div></div>';
    });
    html += '<textarea id="tce-' + g.comment + '" maxlength="1500" placeholder="' + (g.comment === 'dish_comment' ? 'What did you think of the dish?' : 'How was the restaurant?') + '">' + hfEsc(r[g.comment] || '') + '</textarea></div>';
  });
  html += '<div class="tce-err" id="tce-err"></div><div class="tce-btns"><button type="button" class="tce-cancel" onclick="hfTcEditClose()">Cancel</button>'
    + '<button type="button" class="tce-save" id="tce-save" onclick="hfTcEditSave()">Save</button></div></div></div>';
  over.innerHTML = html; over.hidden = false;
}
function hfTcStar(k, v) {
  if (!HF_TC.edit) return;
  HF_TC.edit.scores[k] = v;
  document.querySelectorAll('.tce-stars[data-k="' + k + '"] button').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.v) <= v); });
}
function hfTcEditClose() { var o = document.getElementById('tce-over'); if (o) { o.hidden = true; o.innerHTML = ''; } HF_TC.edit = null; }
async function hfTcEditSave() {
  var e = HF_TC.edit; if (!e) return;
  var btn = document.getElementById('tce-save'), err = document.getElementById('tce-err');
  var scores = {};
  Object.keys(e.scores).forEach(function (k) { if (e.scores[k]) scores[k] = e.scores[k]; });
  btn.disabled = true; btn.textContent = 'Saving…'; err.textContent = '';
  var d = await hfRv({ action: 'my_review_edit', reviewId: e.id, scores: scores,
    dish_comment: document.getElementById('tce-dish_comment').value, restaurant_comment: document.getElementById('tce-restaurant_comment').value });
  if (d.__status === 200 && d.success) {
    hfTcEditClose();
    if (typeof loadMyTastings === 'function') loadMyTastings();
    if (typeof hfAfterEdit === 'function') hfAfterEdit(d.review);
    return;
  }
  btn.disabled = false; btn.textContent = 'Save';
  err.textContent = d.error || 'Could not save. Please try again.';
}

// ── r62: Edit from a dish's reviews (menu page) — the author's own rating, and the turns of a conversation ──
(function () {
  var css = ''
    + '.rr-ctl{display:flex;gap:6px;justify-content:flex-end;margin-top:6px;}'
    + '.rr-ctl button,.rr-mine-edit,.rr-edit-btns button{font-family:var(--sans,system-ui);font-size:.72rem;font-weight:700;border-radius:999px;padding:.28rem .8rem;cursor:pointer;background:#fff;border:1px solid rgba(43,33,26,.18);color:#4A3F37;}'
    + '.rr-mine-edit{margin:.35rem 0 .2rem;border-color:#B01015;color:#B01015;}'
    + 'html[data-site="havana"] .rr-mine-edit{border-color:#2D0077;color:#2D0077;}'
    + '.rr-edit textarea{width:100%;min-height:64px;margin-top:6px;border:1px solid #DDD3C7;border-radius:10px;padding:8px 10px;font:inherit;font-size:.86rem;}'
    + '.rr-edit-btns{display:flex;gap:6px;justify-content:flex-end;margin-top:6px;}'
    + '.rr-edit-btns .rr-save{background:#B01015;border-color:#B01015;color:#fff;}'
    + 'html[data-site="havana"] .rr-edit-btns .rr-save{background:#2D0077;border-color:#2D0077;}'
    + '.rr-edit-btns .rr-del-yes{background:#B01015;border-color:#B01015;color:#fff;}'
    + '.rr-ask{font-size:.8rem;margin-top:6px;}'
    + '.rr-err{color:#B01015;font-size:.78rem;margin-top:4px;}'
    + '.rr-err:empty{display:none;}';
  try { var s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); } catch (e) {}
})();
var HF_RR_ACTION = { reply: ['reply_edit', 'reply_delete'], reply2: ['reply_edit', 'reply_delete'], answer: ['my_answer_edit', 'my_answer_delete'] };
function hfRrBody(ctl, i, extra) {
  var part = ctl.dataset.part, b = { action: HF_RR_ACTION[part][i], reviewId: Number(ctl.dataset.review) };
  if (part !== 'answer') b.turn = part;
  return Object.assign(b, extra || {});
}
function hfRrDone(d) { if (d && d.review) hfRrForget(d.review.id); if (typeof hfReviewChanged === 'function') hfReviewChanged(d.review); }
function hfReplyEditOpen(btn) {
  var ctl = btn.closest('.rr-ctl'), box = btn.closest('.review-reply'); if (!ctl || !box || box.querySelector('.rr-edit')) return;
  var txt = box.querySelector('.rr-text'); var cur = txt ? txt.textContent : '';
  if (txt) txt.hidden = true; ctl.hidden = true;
  var w = document.createElement('div'); w.className = 'rr-edit';
  w.innerHTML = '<textarea maxlength="1500"></textarea><div class="rr-edit-btns"><button type="button" class="rr-cancel">Cancel</button><button type="button" class="rr-save">Save</button></div><div class="rr-err"></div>';
  w.querySelector('textarea').value = cur;
  box.appendChild(w);
  w.querySelector('.rr-cancel').onclick = function () { w.remove(); if (txt) txt.hidden = false; ctl.hidden = false; };
  w.querySelector('.rr-save').onclick = async function () {
    var b = this; b.disabled = true; b.textContent = 'Saving…';
    var d = await hfRv(hfRrBody(ctl, 0, { text: w.querySelector('textarea').value }));
    if (d.__status === 200 && d.success) return hfRrDone(d);
    b.disabled = false; b.textContent = 'Save'; w.querySelector('.rr-err').textContent = d.error || 'Could not save. Please try again.';
  };
  w.querySelector('textarea').focus();
}
function hfReplyDeleteAsk(btn) {
  var ctl = btn.closest('.rr-ctl'), box = btn.closest('.review-reply'); if (!ctl || !box || box.querySelector('.rr-edit')) return;
  ctl.hidden = true;
  var w = document.createElement('div'); w.className = 'rr-edit';
  w.innerHTML = '<div class="rr-ask">Delete this ' + (ctl.dataset.part === 'answer' ? 'answer' : 'reply') + '? It leaves the page; a private copy is kept.</div>'
    + '<div class="rr-edit-btns"><button type="button" class="rr-cancel">Keep it</button><button type="button" class="rr-del-yes">Delete</button></div><div class="rr-err"></div>';
  box.appendChild(w);
  w.querySelector('.rr-cancel').onclick = function () { w.remove(); ctl.hidden = false; };
  w.querySelector('.rr-del-yes').onclick = async function () {
    var b = this; b.disabled = true;
    var d = await hfRv(hfRrBody(ctl, 1));
    if (d.__status === 200 && d.success) return hfRrDone(d);
    b.disabled = false; w.querySelector('.rr-err').textContent = d.error || 'Could not delete it. Please try again.';
  };
}
// r62: which replies on screen this person may change — an owner's or a manager's controls wait for the server's answer
var HF_RR_ASKED = {};
async function hfRrAsk() {
  var els = [].slice.call(document.querySelectorAll('.rr-ctl[data-ask="1"]'));
  if (!els.length) return;
  var ids = [];
  els.forEach(function (e) { var id = Number(e.dataset.review); if (!(id in HF_RR_ASKED) && ids.indexOf(id) < 0) ids.push(id); });
  if (ids.length) {
    ids.forEach(function (id) { HF_RR_ASKED[id] = null; });
    var d = await hfRv({ action: 'reply_rights', reviewIds: ids.slice(0, 60) });
    var got = d.__status === 200 && d.rights ? d.rights : {};
    ids.forEach(function (id) { HF_RR_ASKED[id] = got[id] || {}; });
  }
  [].slice.call(document.querySelectorAll('.rr-ctl[data-ask="1"]')).forEach(function (e) {
    var r = HF_RR_ASKED[Number(e.dataset.review)]; if (!r) return;
    var p = r[e.dataset.part];
    e.removeAttribute('data-ask');
    if (!p || !p.edit) { e.remove(); return; }
    if (!p.del) { var del = e.querySelector('button[onclick^="hfReplyDeleteAsk"]'); if (del) del.remove(); }
    e.hidden = false;
  });
}
function hfRrForget(id) { if (id != null) delete HF_RR_ASKED[Number(id)]; else HF_RR_ASKED = {}; }
// ── r63: the restaurant's rating — what the author said about the restaurant (Sebastian 22:22 → "only the restaurant part") ──
// g = one entry of the list: { ids: [the evening's ratings], h, a, words }. Edit: Hospitality, Atmosphere & Vibe and the
// words, for every rating of that evening; Delete: takes those away, the dish ratings stay.
function hfRoomPlace() { return (window.HF_SITE && HF_SITE.name) || 'the restaurant'; }
function hfRoomOver() {
  var over = document.getElementById('tce-over');
  if (!over) { over = document.createElement('div'); over.id = 'tce-over'; over.className = 'tce-over'; over.setAttribute('role', 'dialog'); over.setAttribute('aria-modal', 'true');
    over.addEventListener('click', function (e) { if (e.target === over) hfTcEditClose(); }); document.body.appendChild(over); }
  return over;
}
function hfRoomEdit(g) {
  if (!g) return;
  var over = hfRoomOver();
  HF_TC.edit = { room: g.ids.slice(), scores: { hospitality: g.h || null, atmosphere_vibe: g.a || null } };
  var star = '<svg viewBox="0 0 100 100"><path d="M50 4 L62 38 L98 38 L69 60 L80 95 L50 73 L20 95 L31 60 L2 38 L38 38 Z"/></svg>';
  var html = '<div class="tce-box"><div class="tce-hd"><h3>Edit what you said</h3><button type="button" class="tce-x" aria-label="Close" onclick="hfTcEditClose()">✕</button></div><div class="tce-bd">'
    + '<div class="tce-dish">' + hfEsc(hfRoomPlace()) + '</div>'
    + '<div class="tce-note">' + (g.ids.length > 1 ? 'This changes it on the ' + g.ids.length + ' dishes you rated that day. ' : '')
    + 'Your dish ratings stay as they are. It shows “Edited”, and the earlier version is kept privately.</div>'
    + '<div class="tce-grp"><h4>About the restaurant</h4>';
  [['hospitality', 'Hospitality', g.h], ['atmosphere_vibe', 'Atmosphere & Vibe', g.a]].forEach(function (k) {
    var v = Number(k[2]) || 0;
    html += '<div class="tce-row"><span>' + k[1] + '</span><div class="tce-stars" data-k="' + k[0] + '" role="radiogroup" aria-label="' + k[1] + '">';
    for (var i = 1; i <= 5; i++) html += '<button type="button" class="' + (i <= v ? 'on' : '') + '" data-v="' + i + '" aria-label="' + i + ' star' + (i > 1 ? 's' : '') + '" onclick="hfTcStar(\'' + k[0] + '\',' + i + ')">' + star + '</button>';
    html += '</div></div>';
  });
  html += '<textarea id="tce-restaurant_comment" maxlength="1500" placeholder="How was the restaurant?">' + hfEsc(g.words || '') + '</textarea></div>'
    + '<div class="tce-err" id="tce-err"></div><div class="tce-btns"><button type="button" class="tce-cancel" onclick="hfTcEditClose()">Cancel</button>'
    + '<button type="button" class="tce-save" id="tce-save" onclick="hfRoomSave()">Save</button></div></div></div>';
  over.innerHTML = html; over.hidden = false;
}
async function hfRoomSave() {
  var e = HF_TC.edit; if (!e || !e.room) return;
  var btn = document.getElementById('tce-save'), err = document.getElementById('tce-err');
  btn.disabled = true; btn.textContent = 'Saving…'; err.textContent = '';
  var d = await hfRv({ action: 'my_room_edit', reviewIds: e.room, scores: { hospitality: e.scores.hospitality || null, atmosphere_vibe: e.scores.atmosphere_vibe || null },
    restaurant_comment: document.getElementById('tce-restaurant_comment').value });
  if (d.__status === 200 && d.success) { hfTcEditClose(); if (typeof hfRoomAfter === 'function') hfRoomAfter(); return; }
  btn.disabled = false; btn.textContent = 'Save';
  err.textContent = d.error || 'Could not save. Please try again.';
}
function hfRoomDeleteAsk(g) {
  if (!g) return;
  var over = hfRoomOver();
  HF_TC.edit = { room: g.ids.slice(), scores: {} };
  over.innerHTML = '<div class="tce-box"><div class="tce-hd"><h3>Delete what you said?</h3><button type="button" class="tce-x" aria-label="Close" onclick="hfTcEditClose()">✕</button></div><div class="tce-bd">'
    + '<div class="tce-dish">' + hfEsc(hfRoomPlace()) + '</div>'
    + '<div class="tce-words">“' + hfEsc(g.words || '') + '”</div>'
    + '<div class="tce-note">Your words and your Hospitality and Atmosphere &amp; Vibe stars leave the page and stop counting'
    + (g.ids.length > 1 ? ', on the ' + g.ids.length + ' dishes you rated that day' : '') + '. Your dish ratings stay. A private copy is kept.</div>'
    + '<div class="tce-err" id="tce-err"></div><div class="tce-btns"><button type="button" class="tce-cancel" onclick="hfTcEditClose()">Keep it</button>'
    + '<button type="button" class="tce-save tce-del" id="tce-save" onclick="hfRoomDelete()">Delete</button></div></div></div>';
  over.hidden = false;
}
async function hfRoomDelete() {
  var e = HF_TC.edit; if (!e || !e.room) return;
  var btn = document.getElementById('tce-save'), err = document.getElementById('tce-err');
  btn.disabled = true; err.textContent = '';
  var d = await hfRv({ action: 'my_room_delete', reviewIds: e.room });
  if (d.__status === 200 && d.success) { hfTcEditClose(); if (typeof hfRoomAfter === 'function') hfRoomAfter(); return; }
  btn.disabled = false; err.textContent = d.error || 'Could not delete it. Please try again.';
}
// the author's own rating, from a dish's reviews
function hfTcEditRow(id) {
  var r = window.HF_REVIEW_ROWS && HF_REVIEW_ROWS[id]; if (!r) return;
  var entry = Object.entries(DISH_ID_MAP).find(function (e) { return e[1] === r.dish_id; });
  var dish = entry ? DISHES.find(function (d) { return d.id === entry[0]; }) : null;
  HF_TC.rows[id] = { r: r, name: dish ? dish.name : 'This dish', place: (window.HF_SITE && HF_SITE.name) || 'The restaurant' };
  hfTcEdit(id);
}
