import { describe, expect, it } from 'vitest';

import { unwrapToolResultText } from './toolResult';

describe('unwrapToolResultText', () => {
  it('从 MCP content blocks 数组壳中取第一个 text 原文', () => {
    const wrapped = JSON.stringify([
      { type: 'text', text: '{"kind":"knowledge-candidates-card"}' },
    ]);
    expect(unwrapToolResultText(wrapped)).toBe('{"kind":"knowledge-candidates-card"}');
  });

  it('兼容对象带 content 数组的壳与非 text 块优先级', () => {
    const wrapped = JSON.stringify({
      content: [{ type: 'image', data: '...' }, { type: 'text', text: 'plain payload' }],
    });
    expect(unwrapToolResultText(wrapped)).toBe('plain payload');
  });

  it('SDK 内置工具的纯字符串与无 text 块的壳原样返回', () => {
    expect(unwrapToolResultText('raw tool output')).toBe('raw tool output');
    const noText = JSON.stringify([{ type: 'image', data: '...' }]);
    expect(unwrapToolResultText(noText)).toBe(noText);
    const plainObject = '{"kind":"geo-operation","operation":{"id":"op-1"}}';
    expect(unwrapToolResultText(plainObject)).toBe(plainObject);
  });
});
