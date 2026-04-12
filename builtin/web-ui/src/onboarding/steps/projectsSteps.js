import { useTranslation } from 'react-i18next';

export function getProjectsSteps(t) {
  return [
    {
      target: 'body',
      content: t('onboarding:projects.intro'),
      disableBeacon: true,
      placement: 'center',
    },
  ];
}