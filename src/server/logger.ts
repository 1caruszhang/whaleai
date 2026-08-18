import { appendUnifiedLog } from './UnifiedLogger';
import { localTimestamp } from '../shared/logTime';
import type { LogEntry, LogLevel } from '../shared/types/log';

export type { LogEntry, LogLevel };

const originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  debug: console.debug.bind(console),
};

let stdioBrokenRef: () => boolean = () => false;
let markStdioBrokenRef: () => void = () => {};

export function setStdioBrokenProbe(probe: () => boolean, marker: () => void): void {
  stdioBrokenRef = probe;
  markStdioBrokenRef = marker;
}

function safeOriginal(method: keyof typeof originalConsole, args: unknown[]): void {
  if (stdioBrokenRef()) return;
  try {
    originalConsole[method](...args);
  } catch {
    try {
      markStdioBrokenRef();
    } catch {
      // A broken diagnostic stream must never interrupt the Sidecar.
    }
  }
}

function formatArgs(args: unknown[]): string {
  return args.map((argument) => {
    if (typeof argument === 'string') return argument;
    if (argument instanceof Error) return `${argument.name}: ${argument.message}`;
    try {
      return typeof argument === 'object' ? JSON.stringify(argument) : String(argument);
    } catch {
      return String(argument);
    }
  }).join(' ');
}

function persist(level: LogLevel, args: unknown[]): void {
  const entry: LogEntry = {
    source: 'node',
    level,
    message: formatArgs(args),
    timestamp: localTimestamp(),
  };
  appendUnifiedLog(entry);
}

export function initLogger(): void {
  console.log = (...args: unknown[]) => {
    safeOriginal('log', args);
    persist('info', args);
  };
  console.error = (...args: unknown[]) => persist('error', args);
  console.warn = (...args: unknown[]) => persist('warn', args);
  console.debug = (...args: unknown[]) => {
    safeOriginal('debug', args);
    persist('debug', args);
  };
  (console.log as unknown as Record<string, boolean>).__patched_by_logger__ = true;
  safeOriginal('log', ['[Logger] Unified logging initialized']);
}

export function restoreConsole(): void {
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.debug = originalConsole.debug;
}
