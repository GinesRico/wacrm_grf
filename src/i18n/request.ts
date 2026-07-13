import { getRequestConfig } from 'next-intl/server';
import defaultMessages from '../../messages/en.json';

type Messages = typeof defaultMessages;

function mergeMessages<T extends Record<string, unknown>>(fallback: T, localeMessages: Partial<T>): T {
  const merged = { ...fallback };

  for (const [key, value] of Object.entries(localeMessages)) {
    const fallbackValue = fallback[key];

    if (
      value &&
      fallbackValue &&
      typeof value === 'object' &&
      typeof fallbackValue === 'object' &&
      !Array.isArray(value) &&
      !Array.isArray(fallbackValue)
    ) {
      merged[key as keyof T] = mergeMessages(
        fallbackValue as Record<string, unknown>,
        value as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      merged[key as keyof T] = value as T[keyof T];
    }
  }

  return merged;
}

export default getRequestConfig(async () => {
  // Read the locale from the environment, defaulting to 'en'
  const locale = process.env.NEXT_PUBLIC_APP_LOCALE || 'en';

  let messages: Messages = defaultMessages;
  try {
    if (locale !== 'en') {
      const localeMessages = (await import(`../../messages/${locale}.json`)).default;
      messages = mergeMessages(defaultMessages, localeMessages);
    }
  } catch {
    messages = defaultMessages;
  }

  return {
    locale,
    messages
  };
});
