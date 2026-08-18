import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';

import { XiaojingThemeRuntime } from '@/theme';

export function renderWithTheme(ui: ReactElement, options?: RenderOptions): RenderResult {
  return render(<XiaojingThemeRuntime>{ui}</XiaojingThemeRuntime>, options);
}
