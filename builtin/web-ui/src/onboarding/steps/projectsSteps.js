import { useTranslation } from 'react-i18next';

export function getProjectsSteps(t) {
  return [
    {
      target: 'body',
      content: t('onboarding:projects.intro'),
      disableBeacon: true,
      placement: 'center',
    },
    {
      target: '.af-hub-card',
      content: t('onboarding:projects.hubIntro'),
      disableBeacon: true,
      placement: 'left',
    },
  ];
}