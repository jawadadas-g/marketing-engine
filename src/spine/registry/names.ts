/**
 * Fold a company name down to what is worth matching on. The stored `name` is
 * always the contributor's; this is only ever compared, never shown.
 *
 * Arabic needs the same treatment as English: the same company is written
 * شركة الفلاح للتجارة on one list and الفلاح للتجاره on another, and the
 * difference is entirely orthographic.
 */

/** Tashkeel (harakat) and tatweel: decoration, never meaning. */
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** Legal-form and generic-trade words, in both languages. */
const NOISE_WORDS = new Set([
  // Arabic
  'شركة',
  'شركه',
  'مؤسسة',
  'مؤسسه',
  'موسسة',
  'موسسه',
  'ش.م.م',
  'ذ.م.م',
  'المحدودة',
  'المحدوده',
  'محدودة',
  'محدوده',
  'للتجارة',
  'للتجاره',
  'التجارية',
  'التجاريه',
  // English
  'co',
  'company',
  'ltd',
  'limited',
  'llc',
  'inc',
  'est',
  'establishment',
  'trading',
  'for',
  'and',
]);

export function normalizeName(name: string): string {
  let text = name.toLowerCase();

  text = text.replace(ARABIC_MARKS, '');
  text = text
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىئ]/g, 'ي')
    .replace(/ؤ/g, 'و');

  // Punctuation goes, so "Co." and "co" and "& Co" fold together. Keep letters
  // and digits of any script.
  text = text.replace(/[^\p{L}\p{N}]+/gu, ' ');

  const words = text
    .split(' ')
    .map((w) => w.trim())
    .filter((w) => w && !NOISE_WORDS.has(w));

  return words.join(' ').trim();
}
