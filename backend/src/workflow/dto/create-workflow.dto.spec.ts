import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWorkflowDto } from './create-workflow.dto.js';
import { WorkflowType } from '../workflow.types.js';

describe('CreateWorkflowDto', () => {
  it.each([WorkflowType.FILE_PARSE, WorkflowType.INDEX, WorkflowType.EXPORT])(
    'rejects unsupported public workflow type %s',
    async (workflowType) => {
      const dto = plainToInstance(CreateWorkflowDto, {
        workflow_type: workflowType,
      });

      const errors = await validate(dto);

      expect(errors).toEqual([
        expect.objectContaining({ property: 'workflow_type' }),
      ]);
    },
  );

  it.each([
    WorkflowType.DIRECTORY,
    WorkflowType.OUTLINE,
    WorkflowType.CONTENT,
    WorkflowType.REWRITE,
    WorkflowType.EXPAND,
    WorkflowType.COMPRESS,
  ])('accepts generation workflow type %s', async (workflowType) => {
    const dto = plainToInstance(CreateWorkflowDto, {
      workflow_type: workflowType,
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });
});
