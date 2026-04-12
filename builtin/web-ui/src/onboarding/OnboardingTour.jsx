import { useState, useEffect, useRef, useMemo } from 'react';
import { Joyride } from 'react-joyride';
import { useTranslation } from 'react-i18next';
import { getProjectsSteps } from './steps/projectsSteps.js';
import { getFlowSteps, getFlowEmptySteps } from './steps/flowSteps.js';

const STORAGE_KEY = 'af:onboarding';

export function OnboardingTour({ page, hasNodes = false }) {
  const { t } = useTranslation();
  const [run, setRun] = useState(false);
  const [steps, setSteps] = useState([]);
  const joyrideRef = useRef(null);

  const allStepsConfig = useMemo(() => {
    return page === 'projects' 
      ? getProjectsSteps(t) 
      : (hasNodes ? getFlowSteps(t) : getFlowEmptySteps(t));
  }, [page, hasNodes, t]);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    console.log('[Onboarding] localStorage:', raw);
    const progress = raw ? JSON.parse(raw) : {};
    console.log('[Onboarding] progress:', progress, 'page:', page);
    
    if (progress.completed || progress[page]) {
      console.log('[Onboarding] skipped - already done');
      setRun(false);
      setSteps([]);
      return;
    }

    console.log('[Onboarding] starting with steps:', allStepsConfig);
    setSteps(allStepsConfig);
    setRun(true);
  }, [page, hasNodes, allStepsConfig]);

  // 监听 Joyride 按钮点击
  useEffect(() => {
    if (!run) return;

    const handleClick = (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      
      const isJoyrideBtn = btn.closest('.react-joyride__tooltip');
      if (!isJoyrideBtn) return;
      
      const text = btn.textContent?.trim();
      
      // 完成或跳过
      if (text === t('onboarding:done') || text === t('onboarding:startCreate') || text === t('onboarding:skip')) {
        const raw = localStorage.getItem(STORAGE_KEY) || '{}';
        const progress = JSON.parse(raw);
        
        if (text === t('onboarding:skip')) {
          progress.projects = true;
          progress.flow = true;
          progress.completed = true;
        } else {
          progress[page] = true;
        }
        
        localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
        setSteps([]);
        setRun(false);
        
        // projects 完成后打开新建弹框并标记需要显示新建引导
        if (page === 'projects' && (text === t('onboarding:done') || text === t('onboarding:startCreate'))) {
          localStorage.setItem('af:newPipelineGuide', 'true');
          setTimeout(() => {
            const createBtn = document.querySelector('.af-create-btn');
            if (createBtn) createBtn.click();
          }, 500);
        }
      }
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [run, page, t]);

  if (!run || steps.length === 0) return null;

  return (
    <Joyride
      ref={joyrideRef}
      steps={steps}
      run={run}
      continuous
      showSkipButton
      showProgress={steps.length > 1}
      styles={{
        options: {
          primaryColor: '#7c4dff',
          textColor: '#ffffff',
          backgroundColor: '#1a1a1a',
          arrowColor: '#1a1a1a',
          overlayColor: 'rgba(0, 0, 0, 0.4)',
          zIndex: 10000,
        },
        tooltip: { borderRadius: '1.5rem', padding: '1.5rem' },
        buttonNext: { borderRadius: '9999px', padding: '0.625rem 1.5rem' },
        buttonSkip: { borderRadius: '9999px', color: '#9ecaff' },
        buttonClose: { display: 'none' },
      }}
      locale={{
        back: t('onboarding:back'),
        next: t('onboarding:next'),
        skip: t('onboarding:skip'),
        last: page === 'projects' ? t('onboarding:startCreate') : t('onboarding:done'),
      }}
      floaterProps={{ disableAnimation: true }}
      scrollToFirstStep
    />
  );
}