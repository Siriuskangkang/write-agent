export function buildOutlinePrompt(params: {
  projectName: string;
  style: string;
  chapterTitle: string;
  sectionTitle: string;
  sectionDescription: string;
  retrievedMaterials: string;
  sectionList?: string;
  stylePrompt?: string;
}): string {
  const hasStyle = !!params.stylePrompt;

  const sectionConstraint = params.sectionList
    ? `\n## 目录小节结构（大纲必须严格按此结构生成，小节数量和标题与目录一一对应）\n${params.sectionList}\n`
    : '';

  const outputFormat = hasStyle
    ? `请以 JSON 格式输出大纲，结构如下：
{
  "node_title": "节点标题",
  "level": "层级名称",
  "sections": [
    {
      "column": "栏目名称（严格按体例规定）",
      "required": true,
      "writing_guide": "写作要点",
      "length_suggestion": "篇幅建议",
      "content_points": ["本栏目要写的具体内容要点"]
    }
  ],
  "key_points": ["重点"],
  "difficulties": ["难点"],
  "source_refs": [{ "file": "文件名", "relevance": "高|中|低" }]
}

要求：
1. sections 中的栏目必须严格按体例规定的顺序和名称
2. content_points 必须基于参考素材，具体可执行
3. 如无重难点或参考资料，也要返回空数组，不要省略字段
4. 只输出 JSON，不要输出其他内容，不要使用 markdown 代码块`
    : `请以 JSON 格式输出大纲，格式如下：
{
  "objectives": ["学习目标1", "学习目标2"],
  "key_points": [
    {
      "point": "关键知识点1",
      "source": "教材概念"
    }
  ],
  "structure": [
    {
      "section": "小节1 / 段落1",
      "summary": "本部分核心内容概述"
    }
  ],
  "case_suggestions": ["适合加入的案例或场景"],
  "highlights": {
    "key_points": ["本节重点1"],
    "difficulties": ["本节难点1"]
  },
  "source_refs": [
    {
      "file": "参考文件名",
      "pages": "12-15",
      "relevance": "高"
    }
  ]
}

要求：
1. 大纲应覆盖小节描述中的所有要点
2. \`objectives\` 必须是字符串数组
3. \`key_points\` 必须是对象数组，每项包含 \`point\` 和 \`source\`
4. \`structure\` 必须是对象数组，每项包含 \`section\` 和 \`summary\`${params.sectionList ? '\n5. structure 中的 section 数量必须与目录小节列表一一对应，不得增减' : ''}
${params.sectionList ? '6' : '5'}. 如无案例、重难点或参考资料，也要返回空数组或空对象，不要省略字段
${params.sectionList ? '7' : '6'}. 只输出 JSON，不要输出其他内容，不要使用 markdown 代码块`;

  return `请为以下教材章节/小节生成详细的写作大纲。

${params.stylePrompt || ''}

## 项目信息
- 书名：${params.projectName}
- 写作风格：${params.style}

## 章节信息
- 所属章节：${params.chapterTitle}
- 小节标题：${params.sectionTitle}
- 小节描述：${params.sectionDescription}
${sectionConstraint}
## 参考素材
${params.retrievedMaterials || '暂无参考素材'}

## 输出要求
${outputFormat}`;
}
