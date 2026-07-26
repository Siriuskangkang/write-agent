export interface MdChapter {
  title: string;
  level: number;
  paragraphs: string[];
}

export interface MdCitation {
  paragraph_key: string;
  file_name: string;
  evidence_text: string;
  page_number: number | null;
  use_type: string;
  reference_text: string;
  reference_number?: number;
  claim_texts?: string[];
}

export interface MarkdownInput {
  projectTitle: string;
  chapters: MdChapter[];
  citations: MdCitation[];
  includeCitations: boolean;
}

export function generateMarkdown(input: MarkdownInput): string {
  const lines: string[] = [];

  // 标题
  lines.push(`# ${input.projectTitle}`);
  lines.push('');

  // 目录
  lines.push('## 目录');
  lines.push('');
  for (const chapter of input.chapters) {
    const indent = '  '.repeat(Math.max(0, chapter.level - 1));
    lines.push(`${indent}- ${chapter.title}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // 正文
  for (const chapter of input.chapters) {
    const prefix = '#'.repeat(Math.min(chapter.level, 6));
    lines.push(`${prefix} ${chapter.title}`);
    lines.push('');

    for (const text of chapter.paragraphs) {
      lines.push(text);
      lines.push('');
    }
  }

  // 引用清单
  if (input.includeCitations && input.citations.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('# 引用清单');
    lines.push('');
    lines.push('| 序号 | 参考文献 | 关联声明 | 引用内容 |');
    lines.push('|------|----------|----------|----------|');

    for (const cite of input.citations) {
      const evidence = cite.evidence_text
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');
      const reference = cite.reference_text.replace(/\|/g, '\\|');
      const claims = (cite.claim_texts ?? [])
        .join('；')
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');
      lines.push(
        `| ${cite.reference_number ?? ''} | ${reference} | ${claims} | ${evidence} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
