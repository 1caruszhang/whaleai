import stylesheetText from './xiaojing.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const xiaojingThemeManifest = {
  id: 'xiaojing',
  displayName: '小鲸同学',
  description: 'Xiaojing whale-blue dark marketing workbench',
  stylesheetText,
} satisfies PresetThemeManifest;
