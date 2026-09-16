// api/_lib/usernames.js
//
// A public handle for every taster, assigned automatically.
//
// Reviews show the name the person typed, which is not unique — a busy
// restaurant will have several people called Karol and no way to tell whose
// comment is whose. A phone number would tell them apart and must never be
// shown. So each account also gets a handle: the first name plus a Roman
// numeral counting how many people have signed up under that name.
//
//   Karol Arevalo signs up first   →  Karol_I
//   Karol Smith signs up later     →  Karol_II
//
// Nobody chooses it and nobody can change it, which is the point: a handle
// people pick is a handle people impersonate each other with.
//
// Three columns, not one:
//   username        the finished handle, unique across the platform
//   username_base   'Karol' — what the numbering counts within
//   username_seq    1, 2, 3 — the plain integer
//
// The integer is stored because Roman numerals do not sort or compare. Asking
// the database for MAX(username_seq) is one cheap indexed lookup; working out
// that MMMCMXCIX comes after MMMCMXCVIII is not.

const ROMAN = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

// Classic Roman numerals stop at 3999. Rather than fail there, the thousands
// simply keep repeating — Karol the four-thousandth gets MMMM and a long name.
// It never runs out, which is what "and on and on until infinity" needs.
export function toRoman(n) {
  if (!Number.isInteger(n) || n < 1) return 'I';
  let out = '';
  for (const [value, symbol] of ROMAN) {
    while (n >= value) { out += symbol; n -= value; }
  }
  return out;
}

// 'josé maría' → 'JoseMaria'. Accents are stripped rather than kept because
// the handle ends up in URLs, search boxes and other people's keyboards, and
// half of them cannot type an accent.
export function usernameBase(firstName) {
  const cleaned = String(firstName || '')
    .normalize('NFD')                    // split 'é' into 'e' + accent
    .replace(/[̀-ͯ]/g, '')     // drop the accent
    .replace(/[^A-Za-z]/g, '');          // letters only: no spaces, digits, emoji

  if (!cleaned) return 'Taster';         // a name written entirely in another script
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

export function formatUsername(base, seq) {
  return base + '_' + toRoman(seq);
}
