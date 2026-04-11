import { useTranslation } from 'react-i18next';

export function getFlowSteps(t) {
  return [
    {
      target: '.af-flow-left-panel',
      content: t('onboarding:flow.palette'),
      disableBeacon: true,
      placement: 'right',
    },
    {
      target: '.af-flow-palette-section--AGENT',
      content: t('onboarding:flow.agentNodes'),
      disableBeacon: true,
      placement: 'right',
    },
    {
      target: '.af-flow-palette-section--TOOL',
      content: t('onboarding:flow.toolNodes'),
      disableBeacon: true,
      placement: 'right',
    },
    {
      target: '.af-flow-palette-section--CONTROL',
      content: t('onboarding:flow.controlNodes'),
      disableBeacon: true,
      placement: 'right',
    },
    {
      target: '.af-flow-empty-hint',
      content: t('onboarding:flow.emptyHint'),
      disableBeacon: true,
      placement: 'top',
    },
    {
      target: '.af-flow-bottom-composer',
      content: t('onboarding:flow.composer'),
      disableBeacon: true,
      placement: 'top',
    },
    {
      target: '.af-flow-toolbar-actions',
      content: t('onboarding:flow.toolbar'),
      disableBeacon: true,
      placement: 'left',
    },
  ];
}

export function getFlowEmptySteps(t) {
  return [
    {
      target: '.af-flow-empty-hint',
      content: t('onboarding:flow.emptyHint'),
      disableBeacon: true,
      placement: 'top',
    },
    {
      target: '.af-flow-bottom-composer',
      content: t('onboarding:flow.composer'),
      disableBeacon: true,
      placement: 'top',
    },
  ];
}