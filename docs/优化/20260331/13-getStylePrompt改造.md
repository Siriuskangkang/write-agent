# getStylePrompt() 改造方案

## 当前代码

**文件：**`backend/src/content/content.service.ts:86-127`

```typescript
private async getStylePrompt(projectId: string): Promise<string> {
  const features = activeTemplate.features;
  return `
## 写作体例要求

### 结构规范
- 章节编号：${features.structure?.chapterFormat || '默认'}
- 小节编号：${features.structure?.sectionFormat || '默认'}
- 最大层级：${features.structure?.maxDepth || 3}

### 语言风格
- 语气：${features.language?.tone || '正式'}
- 人称：${features.language?.person || '第三人称'}
...
`;
}
```

**问题：**
- `features.structure` 不存在，新结构是 `features.hierarchy`
- `features.language.person` 不存在，新结构是 `features.language.addressStyle`
- 缺少关键信息：栏目规范（`columns`）、图表规范（`figures`）、检查清单（`checklist`）

---

## 新的体例 JSON 结构

```json
{
  "hierarchy": {
    "description": "模块→项目→任务→子任务（活动）",
    "levels": [
      { "name": "模块", "numberingRule": "第X模块", "required": true },
      { "name": "项目", "numberingRule": "项目X", "required": true },
      { "name": "任务", "numberingRule": "任务X", "required": true }
    ]
  },
  "columns": [
    {
      "name": "任务情境",
      "level": "任务",
      "position": "任务开头",
      "order": 1,
      "function": "创设具体、真实的工作或生活场景",
      "writingGuide": "描述一个需要运用本任务知识技能来解决的具体问题",
      "lengthSuggestion": "100-200字"
    }
    // ... 更多栏目
  ],
  "figures": {
    "imageNumbering": "图X-X",
    "tableNumbering": "表X-X",
    "captionFormat": "图/表下方居中",
    "referenceStyle": "如图1-1所示"
  },
  "language": {
    "tone": "亲切引导式",
    "terminology": "使用标准术语",
    "addressStyle": "以"你"称呼学生"
  },
  "checklist": [
    "每个模块必须有模块导语",
    "每个项目必须有项目描述、项目目标、项目评价、巩固练习"
  ]
}
```

---

## 改造后的代码

```typescript
private async getStylePrompt(projectId: string): Promise<string> {
  try {
    const templates = await this.styleTemplateService.findAll(projectId);
    const activeTemplate = templates.find(
      (t) => t.status === 'completed' && t.features,
    );

    if (!activeTemplate || !activeTemplate.features) {
      return '';
    }

    const f = activeTemplate.features;

    // 构建层级结构说明
    const hierarchyText = f.hierarchy?.levels
      ?.map(l => `  - ${l.name}：编号规则 ${l.numberingRule}`)
      .join('\n') || '';

    // 构建栏目规范（按层级分组）
    const columnsByLevel = this.groupColumnsByLevel(f.columns || []);
    const columnsText = Object.entries(columnsByLevel)
      .map(([level, cols]) => {
        const colList = cols.map(c =>
          `  - ${c.name}（${c.position}）：${c.function}\n    写作要点：${c.writingGuide}\n    篇幅：${c.lengthSuggestion}`
        ).join('\n');
        return `#### ${level}层级栏目\n${colList}`;
      })
      .join('\n\n');

    return `
## 写作体例要求

请严格遵循以下体例规范：

### 层级结构
${f.hierarchy?.description || ''}

${hierarchyText}

### 栏目规范
${columnsText}

### 图表规范
- 图片编号：${f.figures?.imageNumbering || '图X'}
- 表格编号：${f.figures?.tableNumbering || '表X'}
- 标题格式：${f.figures?.captionFormat || '默认'}
- 引用方式：${f.figures?.referenceStyle || '默认'}

### 语言风格
- 语气：${f.language?.tone || '正式'}
- 术语：${f.language?.terminology || '标准'}
- 称呼：${f.language?.addressStyle || '第三人称'}
- 句式：${f.language?.sentenceStyle || '陈述句'}

### 必备项检查清单
${(f.checklist || []).map(item => `- ${item}`).join('\n')}
`.trim();
  } catch (err) {
    this.logger.warn(`获取体例模板失败: ${err}`);
    return '';
  }
}

// 辅助方法：按层级分组栏目
private groupColumnsByLevel(columns: any[]): Record<string, any[]> {
  return columns.reduce((acc, col) => {
    const level = col.level || '其他';
    if (!acc[level]) acc[level] = [];
    acc[level].push(col);
    return acc;
  }, {});
}
```

---

## 验证方法

在 `generateDirectory()` 方法中打印 `stylePrompt`：

```typescript
const stylePrompt = await this.getStylePrompt(projectId);
console.log('[DEBUG] stylePrompt:', stylePrompt);
```

确认输出包含完整的层级、栏目、图表、语言风格信息。
