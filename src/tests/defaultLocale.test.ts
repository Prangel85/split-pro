import type { NextRequest } from 'next/server';

import { env } from '~/env';
import { proxy } from '~/proxy';
import { getDefaultLocale } from '~/utils/i18n/defaultLocale';

jest.mock('~/env', () => ({
  env: { DEFAULT_LANGUAGE: 'en' },
}));

const mutableEnv = env as { DEFAULT_LANGUAGE: string | undefined };

const createRequest = ({
  pathname = '/home',
  search = '',
  cookieLocale,
}: { pathname?: string; search?: string; cookieLocale?: string } = {}) =>
  ({
    url: `https://split.example.com${pathname}${search}`,
    nextUrl: { pathname, search, locale: 'default' },
    cookies: {
      get: (name: string) =>
        'NEXT_LOCALE' === name && cookieLocale ? { name, value: cookieLocale } : undefined,
    },
  }) as unknown as NextRequest;

describe('getDefaultLocale', () => {
  it.each(['en', 'it', 'pt-BR'])('returns the configured supported locale %p', (locale) => {
    expect(getDefaultLocale(locale)).toBe(locale);
  });

  it.each([undefined, '', 'xx', 'default', 'IT'])('falls back to en for %p', (locale) => {
    expect(getDefaultLocale(locale)).toBe('en');
  });
});

describe('proxy locale redirect', () => {
  beforeEach(() => {
    mutableEnv.DEFAULT_LANGUAGE = 'en';
  });

  it('redirects to English by default', () => {
    const response = proxy(createRequest());
    expect(response?.headers.get('location')).toBe('https://split.example.com/en/home');
  });

  it('redirects to DEFAULT_LANGUAGE when there is no locale cookie', () => {
    mutableEnv.DEFAULT_LANGUAGE = 'it';

    const response = proxy(createRequest({ pathname: '/auth/signin', search: '?error=x' }));

    expect(response?.headers.get('location')).toBe(
      'https://split.example.com/it/auth/signin?error=x',
    );
  });

  it('prefers the NEXT_LOCALE cookie over DEFAULT_LANGUAGE', () => {
    mutableEnv.DEFAULT_LANGUAGE = 'it';

    const response = proxy(createRequest({ cookieLocale: 'de' }));

    expect(response?.headers.get('location')).toBe('https://split.example.com/de/home');
  });

  it('ignores an unsupported DEFAULT_LANGUAGE', () => {
    mutableEnv.DEFAULT_LANGUAGE = 'xx';

    const response = proxy(createRequest());

    expect(response?.headers.get('location')).toBe('https://split.example.com/en/home');
  });
});
