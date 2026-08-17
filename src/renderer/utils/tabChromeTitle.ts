import type { Tab } from '@/types/tab';

type Translate = (key: string) => string;

export function getFixedTabChromeTitle(
  view: Tab['view'],
  t: Translate,
): string | undefined {
  switch (view) {
    case 'settings':
      return t('tabs.settings');
    case 'welcome':
      return t('tabs.welcome');
    case 'brand-archive':
      return t('tabs.brandArchive');
    default:
      return undefined;
  }
}
