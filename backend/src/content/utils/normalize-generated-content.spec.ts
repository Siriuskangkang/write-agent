import { normalizeGeneratedContent } from './normalize-generated-content';

describe('normalizeGeneratedContent', () => {
  it('converts html superscript citations into bracket citations', () => {
    expect(
      normalizeGeneratedContent(
        '连接<sup>2</sup>。多来源印证<sup>2, 3</sup>。',
      ),
    ).toBe('连接[2]。多来源印证[2,3]。');
  });

  it('unwraps math wrappers while preserving the formula text', () => {
    expect(
      normalizeGeneratedContent(
        '为了表达模型：\n\n$$\nMDT = (PE, VE, Ss, DD, CN)\n$$\n\n其中 PE 表示物理实体。',
      ),
    ).toBe(
      '为了表达模型：\n\nMDT = (PE, VE, Ss, DD, CN)\n\n其中 PE 表示物理实体。',
    );
  });

  it('keeps structured paragraph and citation markers intact', () => {
    expect(
      normalizeGeneratedContent(
        '<!-- paragraph_key:p1 -->\n结论<sup>2</sup>\n\n<!-- citations:p1 -->\n- [chunk_1](use_type: summarize) 引用说明',
      ),
    ).toBe(
      '<!-- paragraph_key:p1 -->\n结论[2]\n\n<!-- citations:p1 -->\n- [chunk_1](use_type: summarize) 引用说明',
    );
  });
});
