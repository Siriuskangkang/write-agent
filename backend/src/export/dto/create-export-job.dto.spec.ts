import { validate } from 'class-validator';
import { CreateExportJobDto } from './create-export-job.dto.js';
import { ExportFormat, ExportScope } from '../../common/enums.js';

describe('CreateExportJobDto', () => {
  it('requires chapter_ids when scope is chapters', async () => {
    const dto = Object.assign(new CreateExportJobDto(), {
      format: ExportFormat.DOCX,
      scope: ExportScope.CHAPTERS,
    });

    const errors = await validate(dto);

    expect(errors.some((item) => item.property === 'chapter_ids')).toBe(true);
  });

  it('accepts payload without chapter_ids when scope is full', async () => {
    const dto = Object.assign(new CreateExportJobDto(), {
      format: ExportFormat.DOCX,
      scope: ExportScope.FULL,
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });
});
