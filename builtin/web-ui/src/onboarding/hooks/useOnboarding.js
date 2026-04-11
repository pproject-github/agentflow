const STORAGE_KEY = 'af:onboarding';

export function useOnboarding() {
  const getProgress = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  };

  const isCompleted = () => {
    const progress = getProgress();
    return progress.completed === true;
  };

  const shouldShow = (page) => {
    if (isCompleted()) return false;
    const progress = getProgress();
    return !progress[page];
  };

  const completePage = (page) => {
    try {
      const progress = getProgress();
      const newProgress = {
        ...progress,
        [page]: true,
      };
      const allPages = ['projects', 'flow'];
      const allDone = allPages.every(p => newProgress[p]);
      if (allDone) {
        newProgress.completed = true;
      }
      console.log('[useOnboarding] completePage saving:', newProgress);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newProgress));
      console.log('[useOnboarding] saved, verify:', localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      console.error('[useOnboarding] save failed:', e);
    }
  };

  const completeAll = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ completed: true }));
  };

  const resetTour = () => {
    localStorage.removeItem(STORAGE_KEY);
  };

  const getCurrentPageIndex = (pages) => {
    if (isCompleted()) return pages.length;
    const progress = getProgress();
    for (let i = 0; i < pages.length; i++) {
      if (!progress[pages[i]]) return i;
    }
    return pages.length;
  };

  return {
    shouldShow,
    completePage,
    completeAll,
    resetTour,
    getCurrentPageIndex,
    getProgress,
    isCompleted,
  };
}