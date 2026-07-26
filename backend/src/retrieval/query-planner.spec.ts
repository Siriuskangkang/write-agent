import { planRetrievalQuery } from './query-planner.js';

describe('planRetrievalQuery', () => {
  it('keeps the content topic and caps Chinese sparse terms deterministically', () => {
    const first = planRetrievalQuery({
      query:
        '请根据上传材料撰写数控机床进给伺服系统的工作原理，并说明闭环控制与位置检测的关系',
      task_type: 'content',
    });
    const second = planRetrievalQuery({
      query:
        '请根据上传材料撰写数控机床进给伺服系统的工作原理，并说明闭环控制与位置检测的关系',
      task_type: 'content',
    });

    expect(first).toEqual(second);
    expect(first.terms.length).toBeLessThanOrEqual(12);
    expect(first.terms).toEqual(
      expect.arrayContaining([
        '数控机床',
        '进给伺服系统',
        '闭环控制',
        '位置检测',
      ]),
    );
    expect(first.sparse_query).not.toContain('请根据');
  });

  it('adds task-specific structural intent without asking an LLM', () => {
    const directory = planRetrievalQuery({
      query: '工业机器人安全操作',
      task_type: 'directory',
    });
    const outline = planRetrievalQuery({
      query: '工业机器人安全操作',
      task_type: 'outline',
    });

    expect(directory.intent).toBe('structure');
    expect(outline.intent).toBe('coverage');
    expect(directory.dense_query).toContain('课程结构');
    expect(outline.dense_query).toContain('学习目标');
  });
});
