import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * jsdom 适配：matchMedia（可编程系统深浅色偏好）与 Radix 弹层用到的
 * pointer-capture / scrollIntoView 桩。每个用例重置 localStorage、系统
 * 偏好与 <html class>，保证主题与凭证断言互不污染。
 */

/**
 * jsdom 适配：matchMedia（可编程系统深浅色偏好）与 Radix 弹层用到的
 * pointer-capture / scrollIntoView 桩。每个用例重置 localStorage、系统
 * 偏好与 <html class>，保证主题与凭证断言互不污染。
 */
interface TestWindow extends Window {
  __setPrefersDark(value: boolean): void;
}

let prefersDark = false;

const matchMediaStub = (query: string): MediaQueryList =>
  ({
    matches: query.includes('prefers-color-scheme: dark') && prefersDark,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: matchMediaStub,
});
(window as unknown as TestWindow).__setPrefersDark = (value: boolean) => {
  prefersDark = value;
};

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

beforeEach(() => {
  window.localStorage.clear();
  prefersDark = false;
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
