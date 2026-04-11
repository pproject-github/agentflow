import { useState, useEffect, useRef } from 'react';
import { Joyride, STATUS } from 'react-joyride';
import { useTranslation } from 'react-i18next';
import { getProjectsSteps } from './steps/projectsSteps.js';
import { getFlowSteps, getFlowEmptySteps } from './steps/flowSteps.js';

const STORAGE_KEY = 'af:onboarding';

export function OnboardingTour({ page, hasNodes = false }) {
  const { t } = useTranslation();
  const [run, setRun] = useState(false);
  const [steps, setSteps] = useState([]);
  const [stepIndex, setStepIndex] = useState(0);
  const joyrideRef = useRef(null);

  const allStepsConfig = page === 'projects' 
    ? getProjectsSteps(t) 
    : (hasNodes ? getFlowSteps(t) : getFlowEmptySteps(t));

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    const progress = raw ? JSON.parse(raw) : {};
    
    if (progress.completed || progress[page]) {
      return;
    }

    const timeout = setTimeout(() => {
      const validSteps = allStepsConfig.filter(s => {
        if (s.target === 'body') return true;
        return s.target && document.querySelector(s.target);
      });
      if (validSteps.length > 0) {
        setSteps(validSteps);
        setRun(true);
        setStepIndex(0);
      }
    }, 500);

    return () => clearTimeout(timeout);
  }, [page]);

  // 监听按钮点击
  useEffect(() => {
    if (!run) return;
    
    const handleClick = (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      
      const text = btn.textContent?.trim();
      console.log('[Button clicked]', text, btn.className);
      
      // 手动处理下一步
      if (text === t('onboarding:next')) {
        console.log('[Manual next]', stepIndex, '->', stepIndex + 1);
        setStepIndex(stepIndex + 1);
      }
      
      // 手动处理完成
      if (text === t('onboarding:done') || text === t('onboarding:skip')) {
        console.log('[Manual finish/skip]', text);
        try {
          const raw = localStorage.getItem(STORAGE_KEY) || '{}';
          const progress = JSON.parse(raw);
          progress[page] = true;
          if (text === t('onboarding:skip')) {
            progress.projects = true;
            progress.flow = true;
            progress.completed = true;
          }
          localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
          console.log('[Manual saved]', localStorage.getItem(STORAGE_KEY));
        } catch (e) {
          console.error('[Manual save error]', e);
        }
        setRun(false);
      }
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [run, stepIndex, page, t]);

  const handleCallback = (data) => {
    console.log('[Joyride callback FIRED]', data);
    const { action, status, index } = data;

    if (action === 'next') {
      setStepIndex(index + 1);
    }

    if (status === STATUS.FINISHED || action === 'skip') {
      const raw = localStorage.getItem(STORAGE_KEY) || '{}';
      const progress = JSON.parse(raw);
      progress[page] = true;
      if (action === 'skip') {
        progress.projects = true;
        progress.flow = true;
        progress.completed = true;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
      setRun(false);
    }
  };

  const styles = {
    options: {
      primaryColor: '#7c4dff',
      textColor: '#ffffff',
      backgroundColor: '#1a1a1a',
      arrowColor: '#1a1a1a',
      overlayColor: 'rgba(0, 0, 0, 0.4)',
      spotlightShadow: '0 0 0 4px #7c4dff',
      zIndex: 10000,
      borderRadius: 24,
    },
    tooltip: {
      borderRadius: '1.5rem',
      padding: '1.5rem',
    },
    buttonNext: {
      borderRadius: '9999px',
      padding: '0.625rem 1.5rem',
      fontSize: '0.9375rem',
    },
    buttonBack: {
      borderRadius: '9999px',
      padding: '0.5rem 1rem',
      color: '#ffffff',
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
    },
    buttonSkip: {
      borderRadius: '9999px',
      padding: '0.5rem 0.75rem',
      color: '#9ecaff',
      fontSize: '0.875rem',
    },
    buttonClose: {
      display: 'none',
    },
  };

  const locale = {
    back: t('onboarding:back'),
    next: t('onboarding:next'),
    skip: t('onboarding:skip'),
    last: t('onboarding:done'),
  };

  if (!run || steps.length === 0) return null;

  return (
    <Joyride
      ref={joyrideRef}
      steps={steps}
      run={run}
      stepIndex={stepIndex}
      continuous
      showSkipButton
      showProgress
      debug={false}
      callback={handleCallback}
      styles={styles}
      locale={locale}
      floaterProps={{ disableAnimation: true }}
      scrollToFirstStep
      scrollOffset={100}
      spotlightLegacy={true}
    />
  );
}