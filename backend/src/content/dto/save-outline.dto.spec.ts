import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SaveOutlineDto } from './save-outline.dto';

describe('SaveOutlineDto', () => {
  it('preserves nested outline objects during transform and validation', () => {
    const input = {
      chapter_node_id: 'ch1',
      section_node_id: 'sec1',
      chapter_index: 0,
      chapter_title: '第一章',
      base_version_number: 1,
      content: {
        node_title: '第一章节点',
        level: '模块',
        sections: [
          {
            column: '核心知识',
            required: true,
            writing_guide: '详细描述核心知识点',
            length_suggestion: '500字',
            content_points: ['知识点一', '知识点二'],
          },
        ],
        key_points: ['重点一', '重点二'],
        difficulties: ['难点一'],
        source_refs: [{ file: '白皮书.pdf', pages: '8-12', relevance: '高' }],
      },
    };

    const dto = plainToInstance(SaveOutlineDto, input, {
      enableImplicitConversion: true,
    });
    const errors = validateSync(dto, { whitelist: true });

    expect(errors).toHaveLength(0);
    expect(dto.section_node_id).toBe('sec1');
    expect(dto.content.key_points).toEqual(['重点一', '重点二']);
    expect(dto.content.sections).toHaveLength(1);
    expect(dto.content.sections[0].column).toBe('核心知识');
    expect(dto.content.source_refs).toEqual([
      { file: '白皮书.pdf', pages: '8-12', relevance: '高' },
    ]);
  });
});
