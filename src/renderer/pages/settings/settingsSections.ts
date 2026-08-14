export type SettingsSection =
  | 'general'
  | 'proxy'
  | 'shortcuts'
  | 'providers'
  | 'mcp'
  | 'skills'
  | 'sub-agents'
  | 'plugins'
  | 'agent'
  | 'usage-stats'
  | 'desktop-pet'
  | 'about';

export const VALID_SECTIONS: SettingsSection[] = [
  'general',
  'proxy',
  'shortcuts',
  'providers',
  'mcp',
  'skills',
  'sub-agents',
  'plugins',
  'agent',
  'usage-stats',
  'desktop-pet',
  'about',
];

export const WHALEAI_GITHUB_URL = 'https://github.com/1caruszhang/whaleai';
export const WHALEAI_RELEASES_URL = `${WHALEAI_GITHUB_URL}/releases`;

export const PLAYWRIGHT_DEVICE_PRESETS = [
  'iPhone 15 Pro',
  'iPhone 15',
  'iPhone SE',
  'iPad Pro 11',
  'Pixel 7',
  'Galaxy S23',
];
