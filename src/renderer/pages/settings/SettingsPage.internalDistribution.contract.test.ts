import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsPageSource = readFileSync(
  resolve(import.meta.dirname, 'SettingsPage.tsx'),
  'utf8',
);
const settingsSectionsSource = readFileSync(
  resolve(import.meta.dirname, 'settingsSections.ts'),
  'utf8',
);

describe('Settings internal-distribution contract', () => {
  it('does not restore the upstream source-code action', () => {
    expect(settingsPageSource).not.toContain("tSettings('about.sourceCode')");
    expect(settingsPageSource).not.toContain('MYAGENTS_SOURCE_CODE_URL');
    expect(settingsSectionsSource).not.toContain('MYAGENTS_SOURCE_CODE_URL');
  });

  it('projects the WhaleAI repository instead of the upstream MyAgents repository', () => {
    expect(settingsSectionsSource).toContain(
      "WHALEAI_GITHUB_URL = 'https://github.com/1caruszhang/whaleai'",
    );
    expect(settingsPageSource).toContain('resolvedTheme.hero.productName');
    expect(settingsPageSource).not.toContain('github.com/hAcKlyc/MyAgents');
  });
});
