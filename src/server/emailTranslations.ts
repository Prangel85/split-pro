import { readFileSync } from 'node:fs';
import path from 'node:path';

import { env } from '~/env';
import { FALLBACK_LOCALE, getDefaultLocale, isSupportedLocale } from '~/utils/i18n/defaultLocale';

/*
 * Minimal translations for server-side emails. Strings live in the same `common` catalogs as the
 * UI (key prefix `emails.`), so they are translated through Weblate like everything else.
 * Only simple `{variable}` placeholders are supported.
 */

type Catalog = Record<string, unknown>;

const catalogs = new Map<string, Catalog>();

const isCatalog = (value: unknown): value is Catalog =>
  'object' === typeof value && null !== value && !Array.isArray(value);

const loadCatalog = (locale: string): Catalog => {
  const cached = catalogs.get(locale);
  if (cached) {
    return cached;
  }

  let catalog: Catalog = {};
  try {
    const file = path.join(process.cwd(), 'public', 'locales', locale, 'common.json');
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isCatalog(parsed)) {
      catalog = parsed;
    }
  } catch (error) {
    console.error(`Could not load email translations for "${locale}"`, error);
  }

  catalogs.set(locale, catalog);
  return catalog;
};

const lookup = (catalog: Catalog, key: string): string | undefined => {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (isCatalog(node) ? node[part] : undefined), catalog);
  return 'string' === typeof value && '' !== value ? value : undefined;
};

/** Language for an email: the recipient's preference if supported, else DEFAULT_LANGUAGE. */
export const getEmailLocale = (preferredLanguage?: string | null) =>
  isSupportedLocale(preferredLanguage ?? undefined)
    ? preferredLanguage!
    : getDefaultLocale(env.DEFAULT_LANGUAGE);

export const getEmailTranslator = (locale: string) => {
  const primary = loadCatalog(locale);
  const fallback = FALLBACK_LOCALE === locale ? primary : loadCatalog(FALLBACK_LOCALE);

  return (key: string, values: Record<string, string> = {}) => {
    const template = lookup(primary, key) ?? lookup(fallback, key) ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
  };
};
