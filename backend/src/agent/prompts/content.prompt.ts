export function buildContentPrompt(params: {
  projectName: string;
  style: string;
  chapterTitle: string;
  sectionTitle: string;
  outline: string;
  retrievedMaterials: string;
  assignedEvidenceIds?: string[];
  wordCount: number;
  strictCitation: boolean;
  stylePrompt?: string;
}): string {
  const hasStyle = !!params.stylePrompt;
  const assignedEvidenceIds = params.assignedEvidenceIds ?? [];
  const allowedEvidence =
    assignedEvidenceIds.length > 0 ? assignedEvidenceIds.join('、') : '无';
  const paragraphExample = params.strictCitation
    ? assignedEvidenceIds.length > 0
      ? `段落正文内容。\n${claimMarkerExample(assignedEvidenceIds)}`
      : claimMarkerExample(assignedEvidenceIds)
    : '段落正文内容...';
  const evidenceOutputRules = params.strictCitation
    ? `- ${groundingOutputRule(assignedEvidenceIds)}
- claim_text 必须逐字出现在正文中；只输出 evidence_ids，不输出或推测 offset
- 严格素材模式下，证据不足时明确说明素材缺口，不得伪造引用`
    : '- 普通引用模式使用段落引用块记录来源，不输出原子引用注释';

  const columnRequirement = hasStyle
    ? `
3. **内容主题**：正文内容必须围绕”章节信息”中的章节和小节标题撰写，禁止照搬体例模板中的示例标题（如”任务1 xxx”、”活动名 [xxx]”等）
4. **结构优先级**：正文的栏目结构必须严格遵循上方的”正文体例结构”，而非”写作大纲”中的结构。大纲仅作为内容要点参考，不决定栏目布局
5. 必须按”正文体例结构”中的栏目顺序逐栏输出，不得遗漏或调换
6. 每个栏目以 <!-- column:栏目名称 --> 标记开头，栏目名称使用体例中对应位置的栏目类型名称
7. 栏目内每个段落以 <!-- paragraph_key:pX --> 标记开头
8. 严格遵循每个栏目的 requirement 中的篇幅建议和写作要点
9. 任务实施栏目必须使用”步骤1、步骤2...”编号
10. 禁止使用 Markdown 管道表格（即 | 列1 | 列2 | 这种格式）；如需呈现评价维度或对比内容，改用带编号的列表形式`
    : `3. 按大纲中的段落顺序撰写，每个段落以 <!-- paragraph_key:pX --> 标记开头
4. 禁止使用 Markdown 管道表格（即 | 列1 | 列2 | 这种格式）；如需呈现对比或评价内容，改用带编号的列表形式`;

  const outputExample = hasStyle
    ? `直接输出 Markdown 格式的正文内容。按栏目顺序输出：

<!-- column:栏目名称 -->
<!-- paragraph_key:p1 -->
${paragraphExample}

依次输出所有栏目。`
    : `直接输出 Markdown 格式的正文内容。每个段落按以下格式：

<!-- paragraph_key:p1 -->
${paragraphExample}

依次输出所有段落。`;

  const introLine = hasStyle
    ? `请根据上方的"正文体例结构"模板撰写教材正文。注意：体例模板仅定义栏目布局和写作要求，正文的内容主题由下方"## 章节信息"决定。不要照搬模板中的示例标题。`
    : `请根据大纲和参考素材撰写教材正文。`;

  return `${hasStyle ? params.stylePrompt + '\n\n' : ''}${introLine}
## 项目信息
- 书名：${params.projectName}
- 写作风格：${params.style}

## 章节信息
- 所属章节：${params.chapterTitle}
- 小节标题：${params.sectionTitle}

## 写作大纲
${params.outline}

## 参考素材
${params.retrievedMaterials || '暂无参考素材'}

## 写作要求
1. 目标字数：约 ${params.wordCount} 字
2. 引用要求：${params.strictCitation ? '严格引用模式 - 每段核心论述必须标注引用来源' : '普通引用模式 - 关键论述标注引用来源'}
${columnRequirement}
${hasStyle ? '11' : '4'}. 引用格式：在段落末尾使用 <!-- citations:pX --> 标记，后跟引用列表
${hasStyle ? '12' : '5'}. 不要输出原始 HTML 标签，不要使用”<sup>””<sub>””<br>”等标签
${hasStyle ? '13' : '6'}. 不要使用”$$...$$””\\(...\\)””\\[...\\]”包裹公式；如果确有公式，直接输出公式文本单独成行即可

## 可用证据约束
- 只能使用以下证据 ID：${allowedEvidence}
- 不得引用未分配的 evidence ID，不得自行编造 chunk ID、页码或证据偏移
${evidenceOutputRules}

## 引用格式规范（GB/T 7714）
正文中引用来源时，必须严格遵循以下格式：
- 著作：作者. 书名[M]. 出版地: 出版社, 年份: 页码.
- 期刊：作者. 文章题目[J]. 期刊名, 年份, 卷(期): 起止页码.
- 网络资源：作者. 标题[EB/OL]. (发布日期)[引用日期]. URL.
- 正文内引用统一使用方括号数字标注，如：...研究表明[1]...

## 输出格式
${outputExample}`;
}

export function buildRewritePrompt(params: {
  originalContent: string;
  instruction: string;
  retrievedMaterials: string;
  assignedEvidenceIds?: string[];
}): string {
  const assignedEvidenceIds = params.assignedEvidenceIds ?? [];
  return `请根据以下指令重写内容。

## 原始内容
${params.originalContent}

## 重写指令
${params.instruction}

## 参考素材
${params.retrievedMaterials || '暂无额外素材'}

要求：
1. 保持原有的段落标记格式（<!-- paragraph_key:pX -->）
2. 保留原有的栏目标记格式（<!-- column:栏目名称 -->），不得删除或更改栏目标记
3. 保留或补全对应的 <!-- citations:pX --> 引用块
4. 正文中的引用继续使用 [1] 这类 GB/T 7714 风格数字标注，不要输出”<sup>”等 HTML 标签
5. 不要使用”$$...$$””\\(...\\)””\\[...\\]”包裹公式；如需公式，直接输出公式文本
6. 禁止使用 Markdown 管道表格（即 | 列1 | 列2 | 这种格式）；如需呈现对比或评价内容，改用带编号的列表形式
7. 只能引用本次分配的 evidence ID：${assignedEvidenceIds.join('、') || '无'}
8. ${groundingOutputRule(assignedEvidenceIds)}
9. 不得引用未分配的 evidence ID
10. 输出重写后的完整内容。`;
}

export function buildExpandPrompt(params: {
  originalContent: string;
  targetWordCount: number;
  retrievedMaterials: string;
  assignedEvidenceIds?: string[];
}): string {
  const assignedEvidenceIds = params.assignedEvidenceIds ?? [];
  return `请扩写以下内容，目标字数约 ${params.targetWordCount} 字。

## 原始内容
${params.originalContent}

## 参考素材
${params.retrievedMaterials || '暂无额外素材'}

要求：
1. 保持原有结构和段落标记格式
2. 保留原有的栏目标记格式（<!-- column:栏目名称 -->），不得删除或更改栏目标记
3. 在原有内容基础上补充细节、示例或论述
4. 保留或补全对应的 <!-- citations:pX --> 引用块
5. 新增内容需标注引用来源，正文中的引用继续使用 [1] 这类 GB/T 7714 风格数字标注，不要输出”<sup>”等 HTML 标签
6. 不要使用”$$...$$””\\(...\\)””\\[...\\]”包裹公式；如需公式，直接输出公式文本
7. 禁止使用 Markdown 管道表格（即 | 列1 | 列2 | 这种格式）；如需呈现对比或评价内容，改用带编号的列表形式
8. 只能引用本次分配的 evidence ID：${assignedEvidenceIds.join('、') || '无'}
9. ${groundingOutputRule(assignedEvidenceIds)}
10. 不得引用未分配的 evidence ID
11. 输出扩写后的完整内容`;
}

export function buildCompressPrompt(params: {
  originalContent: string;
  targetWordCount: number;
  retrievedMaterials?: string;
  assignedEvidenceIds?: string[];
}): string {
  const assignedEvidenceIds = params.assignedEvidenceIds ?? [];
  return `请精简以下内容，目标字数约 ${params.targetWordCount} 字。

## 原始内容
${params.originalContent}

## 继承证据快照
${params.retrievedMaterials || '暂无可用证据'}

要求：
1. 保持原有结构和段落标记格式
2. 保留原有的栏目标记格式（<!-- column:栏目名称 -->），不得删除或更改栏目标记
3. 保留核心论述，删减冗余表述
4. 保留必要的 <!-- citations:pX --> 引用块
5. 正文中的引用继续使用 [1] 这类数字标注，不要输出”<sup>”等 HTML 标签
6. 不要使用”$$...$$””\\(...\\)””\\[...\\]”包裹公式；如需公式，直接输出公式文本
7. 禁止使用 Markdown 管道表格（即 | 列1 | 列2 | 这种格式）；如需呈现对比或评价内容，改用带编号的列表形式
8. 只能引用继承的 evidence ID：${assignedEvidenceIds.join('、') || '无'}
9. ${groundingOutputRule(assignedEvidenceIds)}
10. 确保精简后内容完整连贯
11. 输出精简后的完整内容`;
}

function claimMarkerExample(assignedEvidenceIds: string[]): string {
  if (assignedEvidenceIds.length === 0) {
    return '<!-- material_gap:{"reason":"未分配可用证据"} -->';
  }
  return `<!-- claim_evidence:${JSON.stringify({
    claim_text: '段落正文内容。',
    evidence_ids: [assignedEvidenceIds[0]],
  })} -->`;
}

function groundingOutputRule(assignedEvidenceIds: string[]): string {
  if (assignedEvidenceIds.length === 0) {
    return '不得生成事实正文，只输出 <!-- material_gap:{"reason":"未分配可用证据"} -->';
  }
  return `每个事实声明后必须立即紧跟 claim_evidence 注释，注释格式为 ${claimMarkerExample(assignedEvidenceIds)}；具体相邻格式参见下方输出示例；claim_text 必须是带结束标点的完整可见声明，不得输出或猜测 offset`;
}
