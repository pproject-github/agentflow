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
      target: '.af-create-btn',
      content: t('onboarding:projects.create'),
      disableBeacon: true,
      placement: 'bottom',
    },
    {
      target: '.af-search-wrap',
      content: t('onboarding:projects.search'),
      disableBeacon: true,
      placement: 'bottom',
    },
    {
      target: '.af-project-grid',
      content: t('onboarding:projects.cards'),
      disableBeacon: true,
      placement: 'top',
    },
    {
      target: '.af-activity',
      content: t('onboarding:projects.activity'),
      disableBeacon: true,
      placement: 'left-start',
    },
  ];
}