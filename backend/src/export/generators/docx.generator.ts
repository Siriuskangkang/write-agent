import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
} from 'docx';

export interface DocxChapter {
  title: string;
  level: number;
  paragraphs: string[];
}

export interface DocxCitation {
  paragraph_key: string;
  file_name: string;
  evidence_text: string;
  page_number: number | null;
  use_type: string;
  reference_text: string;
  reference_number?: number;
  claim_texts?: string[];
}

export interface DocxInput {
  projectTitle: string;
  chapters: DocxChapter[];
  citations: DocxCitation[];
  includeCitations: boolean;
}

function headingLevel(
  level: number,
): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  if (level <= 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  return HeadingLevel.HEADING_3;
}

export async function generateDocx(input: DocxInput): Promise<Buffer> {
  const children: Paragraph[] = [];

  // 标题页
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: input.projectTitle,
          bold: true,
          size: 48,
          font: { name: '宋体' },
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
    }),
  );

  // 正文章节
  for (const chapter of input.chapters) {
    children.push(
      new Paragraph({
        text: chapter.title,
        heading: headingLevel(chapter.level),
        spacing: { before: 400, after: 200 },
        run: { font: { name: '宋体' } },
      }),
    );

    for (const text of chapter.paragraphs) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text,
              size: 24,
              font: { name: '宋体' },
            }),
          ],
          spacing: { after: 200 },
        }),
      );
    }
  }

  // 引用清单
  if (input.includeCitations && input.citations.length > 0) {
    children.push(
      new Paragraph({
        text: '引用清单',
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 600, after: 200 },
        run: { font: { name: '宋体' } },
      }),
    );

    children.push(
      new Paragraph({
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 1, color: '999999' },
        },
        spacing: { after: 200 },
      }),
    );

    for (const cite of input.citations) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${cite.reference_number ? `[${cite.reference_number}] ` : ''}${cite.reference_text}`,
              bold: true,
              size: 20,
              font: { name: '宋体' },
            }),
          ],
          spacing: { after: 80 },
        }),
      );
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: cite.evidence_text,
              italics: true,
              size: 18,
              font: { name: '宋体' },
              color: '666666',
            }),
          ],
          spacing: { after: 200 },
        }),
      );
      if (cite.claim_texts && cite.claim_texts.length > 0) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `关联声明：${cite.claim_texts.join('；')}`,
                size: 18,
                font: { name: '宋体' },
              }),
            ],
            spacing: { after: 120 },
          }),
        );
      }
    }
  }

  const doc = new Document({
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}
