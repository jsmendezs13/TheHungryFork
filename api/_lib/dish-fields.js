// api/_lib/dish-fields.js
//
// The single list of what a restaurant may change about its own dish, and what
// it may not. manager-dish.js validates against this; manager.html draws a
// form from the matching labels. If the two ever drift, the server rejects the
// unknown field — the checkbox silently fails to save, which is the safe way
// round for a mistake like that to fail.

// ── The 30 allergen columns, exactly as they are named in the database ──────
//
// Ordered by how much harm getting one wrong does. The first nine are the
// major allergens recognised in the United States and account for the large
// majority of serious reactions; they are listed first so a busy manager sees
// them before anything else.
export const ALLERGENS = [
  // The major nine
  'allergen_milk_dairy', 'allergen_eggs', 'allergen_fish', 'allergen_crustaceans',
  'allergen_tree_nuts', 'allergen_peanuts', 'allergen_wheat', 'allergen_soy',
  'allergen_sesame',
  // Widely declared elsewhere, and common enough to matter
  'allergen_molluscs', 'allergen_gluten_cereals', 'allergen_celery',
  'allergen_mustard', 'allergen_sulphites', 'allergen_lupin',
  // The rest
  'allergen_coconut', 'allergen_corn_maize', 'allergen_other_seeds',
  'allergen_other_legumes', 'allergen_buckwheat', 'allergen_rice',
  'allergen_fruits', 'allergen_vegetables', 'allergen_garlic_onion',
  'allergen_spices_herbs', 'allergen_meat_alpha_gal', 'allergen_gelatin_collagen',
  'allergen_yeast', 'allergen_additives_preservatives', 'allergen_other',
];

// ── Free-text fields, with the longest they may be ─────────────────────────
export const TEXT_FIELDS = {
  name:          80,
  description:   600,
  about:         4000,
  ingredients:   1000,
  modifications: 1000,
  wine:          400,
  cocktail:      400,
  allergens_text: 1000,

  // How the dish is classified. Short labels, not essays.
  dish_type:      60,
  cuisine_origin: 60,
  main_ingredient: 60,
  protein_type:   60,
  cooking_method: 60,
  flavor_profile: 60,
  meal_moment:    60,
  temperature:    60,
  spice_level:    60,
  portion_format: 60,
};

// ── Never editable from a browser, and why ─────────────────────────────────
//
//   image, image_open  photography is work Sebastian is paid for
//   slug               it is in URLs and in the category routing
//   restaurant_id      nobody moves a dish to another restaurant
//   id                 obviously
//
// The dish NAME is editable. An earlier version of this file locked it on the
// grounds that reviews were attached to it — that was simply wrong. Reviews
// point at dish_id. A restaurant renaming its own dish breaks nothing.
export const LOCKED = ['id', 'slug', 'restaurant_id', 'image', 'image_open'];

export function isAllergen(field) {
  return ALLERGENS.includes(field);
}
