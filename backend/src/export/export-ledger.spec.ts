import {
  buildExportCitationLedger,
  type ExportLedgerRow,
} from './export.worker.js';
import { generateMarkdown } from './generators/markdown.generator.js';

const row = (overrides: Partial<ExportLedgerRow> = {}): ExportLedgerRow => ({
  cm_claim_id: 'claim-1',
  cm_file_id: 'file-1',
  cm_paragraph_key: 'claim:claim-1',
  cm_evidence_text: '装机容量为 300 MW',
  cm_page_number: 2,
  cm_section_title: '项目概况',
  cm_use_type: 'synthesize',
  cm_evidence_char_start: 100,
  cm_evidence_char_end: 112,
  gc_claim_text: '装机容量为 300 MW。',
  gc_output_char_start: 10,
  ch_page_start: 2,
  ch_page_end: 2,
  ch_heading_path: ['第一章'],
  sf_file_name: '教材.pdf',
  sf_file_type: 'pdf',
  document_order: 10,
  ...overrides,
});

describe('export claim-evidence ledger', () => {
  it('deduplicates one source while retaining every claim link', () => {
    const citations = buildExportCitationLedger([
      row({
        cm_claim_id: 'claim-2',
        gc_claim_text: '年发电量为十二亿千瓦时。',
        gc_output_char_start: 30,
        document_order: 30,
      }),
      row(),
    ]);

    expect(citations).toEqual([
      expect.objectContaining({
        reference_number: 1,
        file_name: '教材.pdf',
        claim_texts: ['装机容量为 300 MW。', '年发电量为十二亿千瓦时。'],
      }),
    ]);
  });

  it('exports stable reference numbers and claim links in markdown', () => {
    const citations = buildExportCitationLedger([row()]);
    const markdown = generateMarkdown({
      projectTitle: '教材',
      chapters: [],
      citations,
      includeCitations: true,
    });

    expect(markdown).toContain(
      '| 1 | 教材[M]. 第一章，第2页，字符100-112. | 装机容量为 300 MW。 |',
    );
  });
});
