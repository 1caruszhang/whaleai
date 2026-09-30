import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * jsdom 适配：matchMedia（可编程系统深浅色偏好）与 Radix 弹层用到的
 * pointer-capture / scrollIntoView 桩。每个用例重置 localStorage、系统
 * 偏好与 <html class>，保证主题与凭证断言互不污染。
 *
 * 票 #62：RTL findBy* 默认 1s 等待上限（asyncUtilTimeout）在并行负载下
 * 不够——jsdom 渲染慢、数据未达即放弃等待（表头/文本还是骨架屏就失败）。
 * 与用例 15s 超时同口径提等待上限到 5s：负载下给足等待时间，根治同族
 * 抖动；只改测试基建，不动用例断言。
 */
configure({ asyncUtilTimeout: 5000 });

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
