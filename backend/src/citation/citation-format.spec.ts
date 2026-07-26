import { renderGbt7714Ledger } from './citation-format.js';

describe('renderGbt7714Ledger', () => {
  it('deduplicates sources while retaining every claim-to-reference link', () => {
    const rendered = renderGbt7714Ledger([
      {
        claim_id: 'claim-2',
        output_char_start: 20,
        file_id: 'file-1',
        file_name: '新能源教材.pdf',
        file_type: 'pdf',
        page_start: 8,
        page_end: 9,
        heading_path: ['第二章', '风电'],
        exact_span_document_start: 120,
        exact_span_document_end: 145,
      },
      {
        claim_id: 'claim-1',
        output_char_start: 2,
        file_id: 'file-1',
        file_name: '新能源教材.pdf',
        file_type: 'pdf',
        page_start: 3,
        page_end: 3,
        heading_path: ['第一章', '概述'],
        exact_span_document_start: 12,
        exact_span_document_end: 32,
      },
      {
        claim_id: 'claim-3',
        output_char_start: 30,
        file_id: 'file-2',
        file_name: '教学课件.pptx',
        file_type: 'pptx',
        page_start: 6,
        page_end: 6,
        heading_path: ['储能'],
        exact_span_document_start: 50,
        exact_span_document_end: 70,
      },
    ]);

    expect(rendered.references).toEqual([
      {
        number: 1,
        file_id: 'file-1',
        text: '新能源教材[M]. 第一章 > 概述，第3页，字符12-32.',
      },
      {
        number: 2,
        file_id: 'file-2',
        text: '教学课件[Z]. 储能，第6张，字符50-70.',
      },
    ]);
    expect(rendered.claim_links).toEqual([
      { claim_id: 'claim-1', reference_number: 1 },
      { claim_id: 'claim-2', reference_number: 1 },
      { claim_id: 'claim-3', reference_number: 2 },
    ]);
  });
});
