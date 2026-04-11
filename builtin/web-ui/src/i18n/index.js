import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from './locales/en/common.json';
import enFlow from './locales/en/flow.json';
import enSettings from './locales/en/settings.json';
import enComposer from './locales/en/composer.json';
import enProject from './locales/en/project.json';
import enOnboarding from './locales/en/onboarding.json';

import zhCommon from './locales/zh/common.json';
import zhFlow from './locales/zh/flow.json';
import zhSettings from './locales/zh/settings.json';
import zhComposer from './locales/zh/composer.json';
import zhProject from './locales/zh/project.json';
import zhOnboarding from './locales/zh/onboarding.json';

const resources = {
  en: {
    common: enCommon,
    flow: enFlow,
    settings: enSettings,
    composer: enComposer,
    project: enProject,
    onboarding: enOnboarding,
  },
  zh: {
    common: zhCommon,
    flow: zhFlow,
    settings: zhSettings,
    composer: zhComposer,
    project: zhProject,
    onboarding: zhOnboarding,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    debug: false,
    ns: ['common', 'flow', 'settings', 'composer', 'project', 'onboarding'],
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      lookupLocalStorage: 'agentflow-lang',
      caches: ['localStorage'],
    },
  });

export default i18n;

export const SUPPORTED_LANGUAGES = [
  { code: 'zh', name: '中文', flag: '🇨🇳' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
];

export function changeLanguage(lang) {
  return i18n.changeLanguage(lang);
}
