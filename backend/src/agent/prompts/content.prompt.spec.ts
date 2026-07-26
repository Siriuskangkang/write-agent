import {
  buildCompressPrompt,
  buildContentPrompt,
  buildExpandPrompt,
  buildRewritePrompt,
} from './content.prompt.js';

describe('buildContentPrompt grounding contract', () => {
  it('allows only assigned evidence ids and requires structured claim markers', () => {
    const prompt = buildContentPrompt({
      projectName: '新能源教材',
      style: '严谨',
      chapterTitle: '风力发电',
      sectionTitle: '装机容量',
      outline: '介绍关键指标',
      retrievedMaterials: '[evidence_id: evidence:chunk-1]\n装机容量为 300 MW',
      assignedEvidenceIds: ['evidence:chunk-1'],
      wordCount: 800,
      strictCitation: true,
    });

    expect(prompt).toContain('只能使用以下证据 ID：evidence:chunk-1');
    expect(prompt).toContain(
      '段落正文内容。\n<!-- claim_evidence:{"claim_text":"段落正文内容。","evidence_ids":["evidence:chunk-1"]} -->',
    );
    expect(prompt).not.toContain('完整可核验声明');
    expect(prompt).toContain('不得引用未分配的 evidence ID');
  });

  it('renders examples from the assigned allowlist instead of fake ids', () => {
    const prompt = buildRewritePrompt({
      originalContent: '原文',
      instruction: '改写',
      retrievedMaterials: '素材',
      assignedEvidenceIds: ['evidence:real-uuid'],
    });

    expect(prompt).toContain('"evidence_ids":["evidence:real-uuid"]');
    expect(prompt).not.toContain('evidence:chunk-id');
    expect(prompt).not.toContain('evidence:chunk-1');
  });

  it('uses a material-gap output contract when no evidence is assigned', () => {
    const prompts = [
      buildContentPrompt({
        projectName: '教材',
        style: '严谨',
        chapterTitle: '第一章',
        sectionTitle: '第一节',
        outline: '大纲',
        retrievedMaterials: '',
        assignedEvidenceIds: [],
        wordCount: 800,
        strictCitation: true,
      }),
      buildRewritePrompt({
        originalContent: '原文',
        instruction: '改写',
        retrievedMaterials: '',
        assignedEvidenceIds: [],
      }),
      buildExpandPrompt({
        originalContent: '原文',
        targetWordCount: 1000,
        retrievedMaterials: '',
        assignedEvidenceIds: [],
      }),
      buildCompressPrompt({
        originalContent: '原文',
        targetWordCount: 500,
        assignedEvidenceIds: [],
        retrievedMaterials: '',
      }),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain(
        '<!-- material_gap:{"reason":"未分配可用证据"} -->',
      );
      expect(prompt).not.toContain('evidence:chunk-id');
      expect(prompt).not.toContain('evidence:chunk-1');
    }
  });

  it('omits atomic claim markers in ordinary citation mode', () => {
    const prompt = buildContentPrompt({
      projectName: '教材',
      style: '严谨',
      chapterTitle: '第一章',
      sectionTitle: '第一节',
      outline: '大纲',
      retrievedMaterials: '参考素材',
      assignedEvidenceIds: ['evidence:chunk-1'],
      wordCount: 800,
      strictCitation: false,
    });

    expect(prompt).toContain('普通引用模式');
    expect(prompt).not.toContain('claim_evidence');
    expect(prompt).not.toContain('material_gap');
  });
});
