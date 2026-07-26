export function buildDirectoryPrompt(params: {
  projectName: string;
  projectType: string | null;
  targetAudience: string | null;
  targetChapters: number;
  style: string;
  description: string | null;
  retrievedMaterials: string;
  stylePrompt: string;
}): string {
  return `请为以下教材项目生成目录结构。

## 项目信息（最高优先级）
这是目录生成的主要依据，标题和内容必须基于这些信息：

- 书名：${params.projectName}
- 类型：${params.projectType ?? '教材'}
- 目标读者：${params.targetAudience ?? '未指定'}
- 目标章节数：${params.targetChapters}
- 写作风格：${params.style}
${params.description ? `- 项目描述：${params.description}` : ''}

## 参考素材（内容来源）
以下是已上传的素材摘要，用于确定目录的具体内容：

${params.retrievedMaterials || '暂无参考素材'}

${params.stylePrompt}

## 输出要求

**核心原则：目录的层级结构必须严格遵循体例模板，不得自行增减层级**：
1. 体例模板中有 children 的节点照搬其子结构，模板中没有 children 或 children 为空的节点就是叶子节点，**禁止为其添加任何子节点**
2. 如果体例模板中"任务"没有子节点，则目录中的"任务"也不能有子节点。绝不能因为"任务"通常应该有"节"就自行添加
3. 所有标题必须反映实际教学内容，绝不能照搬体例中的占位标题
4. **特别禁止**：不得使用"预留任务""预留""（预留）"等占位表述，每个节点都必须有具体的、与教学内容相关的标题
5. 体例中的 title 仅表示"这个位置需要一个该级别的节点"，实际名称必须自行拟定
6. 某些层级在体例中可能简写（如"任务2-4"），实际生成时应展开为独立的、有具体标题的节点

请以 JSON 格式输出目录结构，格式如下：
{
  "nodes": [
    {
      "key": "唯一标识",
      "level": "层级名称（如：模块、项目、任务）",
      "title": "标题（含编号，如：第1模块 xxx）",
      "description": "简要描述",
      "material_support": "充足|一般|不足（仅叶子节点填写）",
      "children": [ ...子节点，结构相同... ]
    }
  ]
}

要求：
1. 顶层节点数量等于 ${params.targetChapters}
2. 目录层级严格按体例模板的层级生成，不多不少
3. 叶子节点（最底层）必须填写 material_support
4. 只输出 JSON，不要输出其他内容`;
}
