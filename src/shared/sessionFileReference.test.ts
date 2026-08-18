import { describe, expect, it } from 'vitest';

import {
  buildSessionFileToken,
  extractSessionFileReferences,
  isSessionFileReference,
  isSessionFileTextReadable,
  sessionFileReferenceName,
  sessionFilesTargetDir,
} from './sessionFileReference';

describe('sessionFileReference', () => {
  it('token 构建与提取可往返，含空格的文件名经百分号编码不丢字', () => {
    const path = 'xiaojing_files/s1/若如初见 医学美学.md';
    const token = buildSessionFileToken(path);
    const text = `帮我看一下这个文件 ${token} 然后给建议`;
    const { cleanText, references } = extractSessionFileReferences(text);
    expect(cleanText).toBe('帮我看一下这个文件 然后给建议');
    expect(references).toEqual([path]);
  });

  it('提取按出现顺序去重，旧格式（未编码）token 兼容', () => {
    const tokenA = '@xiaojing_files/s1/a.md';
    const text = `${tokenA} 先聊这个 ${tokenA} 再看 @xiaojing_files/s1/b.md`;
    const { references } = extractSessionFileReferences(text);
    expect(references).toEqual(['xiaojing_files/s1/a.md', 'xiaojing_files/s1/b.md']);
  });

  it('isSessionFileReference 只放行当前会话三段路径，拒绝逃逸与他人会话', () => {
    expect(isSessionFileReference('xiaojing_files/s1/a.md', 's1')).toBe(true);
    expect(isSessionFileReference('xiaojing_files/s2/a.md', 's1')).toBe(false);
    expect(isSessionFileReference('xiaojing_files/s1/../a.md', 's1')).toBe(false);
    expect(isSessionFileReference('xiaojing_files/s1/a/b.md', 's1')).toBe(false);
    expect(isSessionFileReference('materials/s1/a.md', 's1')).toBe(false);
    expect(isSessionFileReference('', 's1')).toBe(false);
    expect(isSessionFileReference('xiaojing_files/s1/a.md', '')).toBe(false);
  });

  it('文本白名单覆盖常见文档与代码，二进制类型判不可直读', () => {
    expect(isSessionFileTextReadable('xiaojing_files/s1/关于我们.md')).toBe(true);
    expect(isSessionFileTextReadable('xiaojing_files/s1/data.csv')).toBe(true);
    expect(isSessionFileTextReadable('xiaojing_files/s1/index.html')).toBe(true);
    expect(isSessionFileTextReadable('xiaojing_files/s1/无扩展名')).toBe(false);
    expect(isSessionFileTextReadable('xiaojing_files/s1/brochure.pdf')).toBe(false);
    expect(isSessionFileTextReadable('xiaojing_files/s1/photo.png')).toBe(false);
    expect(isSessionFileTextReadable('xiaojing_files/s1/report.docx')).toBe(false);
  });

  it('sessionFilesTargetDir 与文件名派生符合会话私有布局', () => {
    expect(sessionFilesTargetDir('s1')).toBe('xiaojing_files/s1');
    expect(sessionFileReferenceName('xiaojing_files/s1/a.md')).toBe('a.md');
    expect(sessionFileReferenceName('a.md')).toBe('a.md');
  });
});
