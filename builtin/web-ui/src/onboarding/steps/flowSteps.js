import { useTranslation } from 'react-i18next';

export function getFlowSteps(t) {
  return [
    {
      target: 'body',
      content: t('onboarding:flow.intro'),
      disableBeacon: true,
      placement: 'center',
    },
  ];
}

export function getFlowEmptySteps(t) {
  return [
    {
      target: 'body',
      content: t('onboarding:flow.introEmpty'),
      disableBeacon: true,
      placement: 'center',
    },
  ];
}