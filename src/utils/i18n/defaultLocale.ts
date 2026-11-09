import { getSupportedLanguages } from './client';

export const FALLBACK_LOCALE = 'en';

export const isSupportedLocale = (locale: string | undefined): locale is string =>
  undefined !== locale && getSupportedLanguages().some(({ code }) => code === locale);

/**
 * Locale used when a visitor has neither a saved preference nor a NEXT_LOCALE cookie.
 * Falls back to English when DEFAULT_LANGUAGE is unset or not a supported locale.
 */
export const getDefaultLocale = (configured: string | undefined): string =>
  isSupportedLocale(configured) ? configured : FALLBACK_LOCALE;
