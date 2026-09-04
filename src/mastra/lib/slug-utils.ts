/**
 * Utility functions for generating standardized, filesystem-safe English kebab-case slugs.
 */

const DIACRITICS_MAP: Record<string, string> = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
  Ą: 'a', Ć: 'c', Ę: 'e', Ł: 'l', Ń: 'n', Ó: 'o', Ś: 's', Ź: 'z', Ż: 'z',
  ä: 'a', ö: 'o', ü: 'u', ß: 'ss', é: 'e', è: 'e', ê: 'e', à: 'a', ç: 'c',
};

/**
 * Normalizes text to ASCII lowercase kebab-case.
 */
export function toKebabCase(input: string): string {
  if (!input) return '';
  
  let cleaned = input;
  for (const [char, replacement] of Object.entries(DIACRITICS_MAP)) {
    cleaned = cleaned.replaceAll(char, replacement);
  }

  return cleaned
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove remaining diacritic marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')     // replace non-alphanumeric with dash
    .replace(/^-+|-+$/g, '')         // trim leading/trailing dashes
    .replace(/-+/g, '-');            // collapse multiple dashes
}

/**
 * Builds a clean project identifier in the format: <brand-name>-<english-description>
 * e.g. "Zagroda", "Wiosenne Menu Degustacyjne" -> "zagroda-spring-tasting-menu"
 */
export function buildStandardProjectSlug(brandName: string, description?: string): string {
  const brandSlug = toKebabCase(brandName || 'project');
  const descSlug = description ? toKebabCase(description) : '';

  if (!descSlug) {
    return brandSlug;
  }

  if (descSlug.startsWith(brandSlug)) {
    return descSlug;
  }

  return `${brandSlug}-${descSlug}`;
}
