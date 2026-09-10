// dishes.js — the menu, loaded from Supabase instead of hardcoded in each page.
//
// Until now index.html and menu.html each carried their own copy of the dish
// list AND their own DISH_ID_MAP of slug -> database id. The two had drifted
// badly apart:
//
//   menu.html  pointed BOTH 'sliced-steak' and 'tbone-fork-steak' at dish #2,
//              so ratings for two different dishes were stored together.
//   index.html still listed 'steak-frites', 'lobster-ravioli' and
//              'atlantic-salmon' — dishes that no longer exist on the menu —
//              and pointed the T-Bone at #2, which is now the Korean BBQ Wing.
//
// There is one source of truth now: the dishes table. Nothing here hardcodes
// which dish is which, so the two pages cannot disagree again.
//
// Load AFTER the page's inline script has defined SUPABASE_URL, SUPABASE_KEY
// and RESTAURANT_ID — or before it, since nothing here reads them until
// loadDishes() is actually called.

var DISHES = [];
var DISH_ID_MAP = {};

// The database column names and the shape the pages already expect are not the
// same. Translating here means no page code had to change.
function normalizeDish(row) {
  return {
    id:        row.slug,              // what the pages call a dish
    dbId:      row.id,                // what reviews are stored against
    name:      row.name,
    desc:      row.description || '',
    price:     Number(row.price),
    emoji:     row.emoji || '🍽️',
    category:  row.restaurant_category,
    img:       row.image || '',
    imgOpen:   row.image_open || '',
    about:     row.about || '',
    allergens: row.allergens_text || '',
    mods:      row.modifications || '',
    wine:      row.wine || '',
    cocktail:  row.cocktail || '',
    ingredients: row.ingredients
      ? String(row.ingredients).split(',').map(s => s.trim()).filter(Boolean)
      : [],
    soldOutUntil: row.sold_out_until ? new Date(row.sold_out_until) : null,
    chefsPick: !!row.is_chefs_pick,
    hidden:    !!row.is_hidden
  };
}

// A dish stays sold out until the manager clears it by hand — deliberately no
// automatic reset, so nothing comes back on the menu without someone deciding
// it is actually available again.
function dishIsSoldOut(d) {
  return !!(d && d.soldOutUntil);
}

// Which dish is the Chef's Pick is a flag on the dish now, set by the manager
// in one click, rather than a slug written into the pages. The category
// fallback keeps the cave populated on restaurants where nobody has set the
// flag yet; it can go once every restaurant has one.
function chefsPickDishes() {
  const flagged = DISHES.filter(d => d.chefsPick);
  return flagged.length ? flagged : DISHES.filter(d => d.category === 'chefs-pick');
}

const DISH_COLUMNS = [
  'id','slug','name','description','price','emoji','restaurant_category',
  'image','image_open','about','allergens_text','modifications','wine',
  'cocktail','ingredients','is_chefs_pick','sort_order','is_hidden',
  'sold_out_until'
].join(',');

async function loadDishes() {
  const url = SUPABASE_URL
    + '/rest/v1/dishes?restaurant_id=eq.' + RESTAURANT_ID
    + '&is_hidden=eq.false'
    + '&select=' + DISH_COLUMNS
    + '&order=sort_order.asc';

  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  if (!res.ok) throw new Error('dishes request failed: ' + res.status);

  const rows = await res.json();
  // An empty menu is treated as a failure rather than rendered as an empty
  // restaurant. Showing nothing is bad; showing a stale hardcoded menu with
  // wrong prices would be worse, so there is deliberately no fallback copy.
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('no dishes returned');

  DISHES = rows.map(normalizeDish);
  DISH_ID_MAP = {};
  DISHES.forEach(d => { DISH_ID_MAP[d.id] = d.dbId; });
  return DISHES;
}
