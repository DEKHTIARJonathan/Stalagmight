import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';

const isDev = import.meta.env.DEV;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
    saveMissing: true,
    parseMissingKeyHandler: isDev ? (key) => `[${key}]` : () => '',
    missingKeyHandler: (_lngs, _ns, key) => {
      if (isDev) {
        console.warn(`[i18n] Missing key: ${key}`);
      } else {
        console.warn(`[i18n] Missing key in production: ${key}`);
      }
    },
    detection: {
      order: ['navigator'],
      caches: [],
    },
  });

export default i18n;
