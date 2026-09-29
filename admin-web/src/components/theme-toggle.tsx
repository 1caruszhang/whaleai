import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTheme, type Theme } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof SunIcon }[] = [
  { value: 'light', label: '浅色', icon: SunIcon },
  { value: 'dark', label: '深色', icon: MoonIcon },
  { value: 'system', label: '跟随系统', icon: MonitorIcon },
];

/** 侧边栏主题切换（票 46）：浅色 / 深色 / 跟随系统，持久化 localStorage。 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const active = THEME_OPTIONS.find(option => option.value === theme) ?? THEME_OPTIONS[2]!;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="切换主题">
          <active.icon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-32">
        {THEME_OPTIONS.map(option => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => setTheme(option.value)}
            aria-label={option.label}
          >
            <option.icon className="size-4" />
            <span>{option.label}</span>
            {theme === option.value && <CheckIcon className="ml-auto size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
