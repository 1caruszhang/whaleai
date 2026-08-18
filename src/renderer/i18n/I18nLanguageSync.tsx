import { useEffect } from 'react';

import { i18n } from './index';

/** Xiaojing v1 has one authored language; no generic language settings surface. */
export function XiaojingI18nSync() {
  useEffect(() => {
    document.documentElement.lang = 'zh-CN';
    if (i18n.language !== 'zh-CN') void i18n.changeLanguage('zh-CN');
  }, []);
  return null;
}
