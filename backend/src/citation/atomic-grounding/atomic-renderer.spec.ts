import type {
  AtomicVerificationResult,
  CanonicalAtomicClaimV1,
  GroundedDraftProposal,
} from './contracts.js';
import {
  escapePlainTextV1,
  renderAtomicDraftV1,
  type AtomicRenderInput,
} from './atomic-renderer.js';

function claimBase(
  candidateClaimKey: string,
  sourceClaimText: string,
  fragment: Omit<
    CanonicalAtomicClaimV1['fragment'],
    'previous_structure_id' | 'next_structure_id'
  > & {
    previous_structure_id?: string | null;
    next_structure_id?: string | null;
  },
): Omit<CanonicalAtomicClaimV1, 'rendered_claim_text'> {
  return {
    canonical_claim_version: 'canonical-atomic-claim.v1',
    candidate_claim_key: candidateClaimKey,
    source_claim_text_nfc: sourceClaimText,
    subject_anchor: {
      surface_nfc: sourceClaimText.slice(0, 1),
      start_utf16: 0,
      end_utf16: 1,
    },
    predicate_anchor: {
      surface_nfc: sourceClaimText.slice(1, 2),
      start_utf16: 1,
      end_utf16: 2,
    },
    polarity: 'affirmed',
    quantifier: 'plain',
    quantities: [],
    evidence_ids: ['evidence:1'],
    fragment: {
      ordinal: fragment.ordinal,
      presentation: fragment.presentation,
      previous_structure_id: fragment.previous_structure_id ?? 'heading',
      next_structure_id: fragment.next_structure_id ?? null,
    },
    revision: {
      attempt: 0,
      revision_of_candidate_claim_key: null,
    },
  };
}

function rendererInput(): AtomicRenderInput {
  const firstText = '事实<!--x--> 😀。';
  const secondText = 'a\\b *raw* <b>&nbsp;</b> $x$';
  const proposal: GroundedDraftProposal = {
    schema_version: 'grounded-draft.v1',
    status: 'draft',
    claims: [
      {
        proposal_claim_id: 'claim-1',
        revision_of_candidate_claim_key: null,
        claim_text: firstText,
        span: {
          fragment_id: 'claim-fragment-1',
          start_utf16: 0,
          end_utf16: firstText.length,
        },
        subject: { surface: '事', start_utf16: 0, end_utf16: 1 },
        predicate: { surface: '实', start_utf16: 1, end_utf16: 2 },
        polarity: 'affirmed',
        quantifier: 'plain',
        quantities: [],
        evidence_ids: ['evidence:1'],
      },
      {
        proposal_claim_id: 'claim-2',
        revision_of_candidate_claim_key: null,
        claim_text: secondText,
        span: {
          fragment_id: 'claim-fragment-2',
          start_utf16: 0,
          end_utf16: secondText.length,
        },
        subject: { surface: 'a', start_utf16: 0, end_utf16: 1 },
        predicate: { surface: '\\', start_utf16: 1, end_utf16: 2 },
        polarity: 'affirmed',
        quantifier: 'plain',
        quantities: [],
        evidence_ids: ['evidence:1'],
      },
    ],
    render_fragments: [
      {
        fragment_id: 'claim-fragment-2',
        kind: 'claim_ref',
        claim_id: 'claim-2',
        presentation: 'ordered_item',
      },
      {
        fragment_id: 'column-fragment',
        kind: 'structure_ref',
        structure_id: 'column',
        presentation: 'column',
      },
      {
        fragment_id: 'paragraph',
        kind: 'separator',
        token: 'paragraph_break',
      },
      {
        fragment_id: 'heading-fragment',
        kind: 'structure_ref',
        structure_id: 'heading',
        presentation: 'heading_1',
      },
      {
        fragment_id: 'line-1',
        kind: 'separator',
        token: 'line_break',
      },
      {
        fragment_id: 'claim-fragment-1',
        kind: 'claim_ref',
        claim_id: 'claim-1',
        presentation: 'bullet',
      },
      {
        fragment_id: 'line-2',
        kind: 'separator',
        token: 'line_break',
      },
    ],
    ordering: [
      'heading-fragment',
      'line-1',
      'column-fragment',
      'line-2',
      'claim-fragment-1',
      'paragraph',
      'claim-fragment-2',
    ],
    material_gap: null,
  };
  const verification: AtomicVerificationResult = {
    decision: 'ALLOW',
    canonical_proposal: proposal,
    claims: [
      {
        candidate_claim_key: 'candidate-1',
        canonical_claim_base: claimBase('candidate-1', firstText, {
          ordinal: 4,
          presentation: 'bullet',
          previous_structure_id: 'column',
        }),
        support_status: 'SUPPORTED',
        support_score: '1',
        verification_method: 'atomic_extract_exact',
        evidence_refs: [
          {
            evidence_id: 'evidence:1',
            evidence_snapshot_digest: 'a'.repeat(64),
          },
        ],
        reason_codes: [],
      },
      {
        candidate_claim_key: 'candidate-2',
        canonical_claim_base: claimBase('candidate-2', secondText, {
          ordinal: 6,
          presentation: 'ordered_item',
          previous_structure_id: 'column',
        }),
        support_status: 'SUPPORTED',
        support_score: '1',
        verification_method: 'atomic_extract_exact',
        evidence_refs: [
          {
            evidence_id: 'evidence:1',
            evidence_snapshot_digest: 'a'.repeat(64),
          },
        ],
        reason_codes: [],
      },
    ],
    material_gap_reason: null,
  };
  return {
    verification,
    render_context: {
      context_version: 'approved-render-context.v1',
      entries: [
        {
          structure_id: 'column',
          source_kind: 'style_template',
          source_id: 'style-1',
          source_version: '1',
          label_nfc: '摘要',
          presentation: 'column',
        },
        {
          structure_id: 'heading',
          source_kind: 'outline',
          source_id: 'outline-1',
          source_version: '1',
          label_nfc: '章节',
          presentation: 'heading_1',
        },
      ],
    },
  };
}

describe('escapePlainTextV1', () => {
  it('escapes model Markdown, HTML, comments, entities, math and backslash in one pass', () => {
    expect(
      escapePlainTextV1(
        '<!-- injected --> *raw* <b>&nbsp;</b> $x$ [link](x) a\\b 😀𐐷',
      ),
    ).toBe(
      '\\<\\!\\-\\- injected \\-\\-\\> \\*raw\\* \\<b\\>\\&nbsp\\;\\<\\/b\\> \\$x\\$ \\[link\\]\\(x\\) a\\\\b 😀𐐷',
    );
    expect(escapePlainTextV1('\\')).toBe('\\\\');
  });

  it.each([
    'e\u0301',
    'line\r\nbreak',
    'line\nbreak',
    `nul\u0000byte`,
    'high\uD800surrogate',
    'low\uDC00surrogate',
  ])('rejects non-canonical or control source text: %j', (source) => {
    expect(() => escapePlainTextV1(source)).toThrow('RENDER_FAILED');
  });
});

describe('renderAtomicDraftV1', () => {
  it('renders exact server-only bytes in ordering and records UTF-16 claim spans', () => {
    const rendered = renderAtomicDraftV1(rendererInput());

    expect(rendered.text).toBe(
      '# 章节\n' +
        '<!-- column:摘要 -->\n' +
        '<!-- paragraph_key:p1 -->\n' +
        '- 事实\\<\\!\\-\\-x\\-\\-\\> 😀。\n\n' +
        '<!-- paragraph_key:p2 -->\n' +
        '1. a\\\\b \\*raw\\* \\<b\\>\\&nbsp\\;\\<\\/b\\> \\$x\\$',
    );
    expect(rendered.utf8_byte_length).toBe(
      Buffer.byteLength(rendered.text, 'utf8'),
    );
    expect(rendered.utf16_length).toBe(rendered.text.length);
    expect(rendered.claims).toHaveLength(2);
    for (const span of rendered.claims) {
      expect(
        rendered.text.slice(
          span.output_char_start_utf16,
          span.output_char_end_utf16,
        ),
      ).toBe(span.rendered_claim_text);
    }
    expect(rendered.claims).toEqual([
      expect.objectContaining({
        candidate_claim_key: 'candidate-1',
        rendered_claim_text: '事实\\<\\!\\-\\-x\\-\\-\\> 😀。',
        fragment_ordinal: 4,
        previous_structure_id: 'column',
        next_structure_id: null,
      }),
      expect.objectContaining({
        candidate_claim_key: 'candidate-2',
        rendered_claim_text:
          'a\\\\b \\*raw\\* \\<b\\>\\&nbsp\\;\\<\\/b\\> \\$x\\$',
        fragment_ordinal: 6,
        previous_structure_id: 'column',
        next_structure_id: null,
      }),
    ]);
  });

  it('preserves valid astral pairs with exact UTF-8 length and UTF-16 offsets', () => {
    const input = rendererInput();
    const source = 'A😀𐐷B';
    const proposalClaim = input.verification.canonical_proposal.claims[0];
    proposalClaim.claim_text = source;
    proposalClaim.span.end_utf16 = source.length;
    proposalClaim.subject = { surface: 'A', start_utf16: 0, end_utf16: 1 };
    proposalClaim.predicate = {
      surface: '😀',
      start_utf16: 1,
      end_utf16: 3,
    };
    const canonicalClaim = input.verification.claims[0].canonical_claim_base;
    canonicalClaim.source_claim_text_nfc = source;
    canonicalClaim.subject_anchor = {
      surface_nfc: 'A',
      start_utf16: 0,
      end_utf16: 1,
    };
    canonicalClaim.predicate_anchor = {
      surface_nfc: '😀',
      start_utf16: 1,
      end_utf16: 3,
    };

    const rendered = renderAtomicDraftV1(input);
    const span = rendered.claims[0];

    expect(span.rendered_claim_text).toBe(source);
    expect(span.output_char_end_utf16 - span.output_char_start_utf16).toBe(6);
    expect(
      rendered.text.slice(
        span.output_char_start_utf16,
        span.output_char_end_utf16,
      ),
    ).toBe(source);
    expect(rendered.utf8_byte_length).toBe(
      Buffer.byteLength(rendered.text, 'utf8'),
    );
    expect(Buffer.byteLength(span.rendered_claim_text, 'utf8')).toBe(10);
  });

  it('derives all headings, item prefixes, separators and controls from closed enums', () => {
    const input = rendererInput();
    input.verification.canonical_proposal.render_fragments[0] = {
      fragment_id: 'claim-fragment-2',
      kind: 'claim_ref',
      claim_id: 'claim-2',
      presentation: 'sentence',
    };
    input.verification.claims[1].canonical_claim_base.fragment.presentation =
      'sentence';
    input.verification.canonical_proposal.render_fragments[3] = {
      fragment_id: 'heading-fragment',
      kind: 'structure_ref',
      structure_id: 'heading',
      presentation: 'heading_2',
    };
    input.render_context.entries[1].presentation = 'heading_2';
    const rendered = renderAtomicDraftV1(input);

    expect(rendered.text).toContain('## 章节\n');
    expect(rendered.text).toContain('<!-- column:摘要 -->');
    expect(rendered.text).toContain('<!-- paragraph_key:p2 -->\na\\\\b');
    expect(rendered.text).not.toContain('<!-- injected -->');
  });

  it.each([
    ['non-NFC', 'e\u0301'],
    ['CR', 'bad\rlabel'],
    ['LF', 'bad\nlabel'],
    ['control', `bad\u0000label`],
    ['left angle', 'bad<label'],
    ['right angle', 'bad>label'],
    ['comment close', 'bad--label'],
    ['byte limit', '界'.repeat(67)],
    ['isolated high surrogate', 'bad\uD800label'],
    ['isolated low surrogate', 'bad\uDC00label'],
  ])('fails closed for an invalid context label: %s', (_name, label) => {
    const input = rendererInput();
    input.render_context.entries[0].label_nfc = label;

    expect(() => renderAtomicDraftV1(input)).toThrow('RENDER_FAILED');
  });

  it('rejects presentation mismatch, missing structures and unknown fragment kinds', () => {
    const mismatch = rendererInput();
    mismatch.render_context.entries[0].presentation = 'heading_1';
    expect(() => renderAtomicDraftV1(mismatch)).toThrow('RENDER_FAILED');

    const missing = rendererInput();
    missing.render_context.entries = missing.render_context.entries.filter(
      (entry) => entry.structure_id !== 'column',
    );
    expect(() => renderAtomicDraftV1(missing)).toThrow('RENDER_FAILED');

    const literal = rendererInput();
    literal.verification.canonical_proposal.render_fragments[0] = {
      fragment_id: 'claim-fragment-2',
      kind: 'literal',
      value: '<!-- forged -->',
    } as never;
    expect(() => renderAtomicDraftV1(literal)).toThrow('RENDER_FAILED');
  });

  it('rejects missing, multiply consumed, and presentation-mismatched claims', () => {
    const unconsumed = rendererInput();
    unconsumed.verification.canonical_proposal.ordering =
      unconsumed.verification.canonical_proposal.ordering.filter(
        (id) => id !== 'claim-fragment-2',
      );
    expect(() => renderAtomicDraftV1(unconsumed)).toThrow('RENDER_FAILED');

    const duplicate = rendererInput();
    duplicate.verification.canonical_proposal.render_fragments.push({
      fragment_id: 'duplicate-claim',
      kind: 'claim_ref',
      claim_id: 'claim-1',
      presentation: 'bullet',
    });
    duplicate.verification.canonical_proposal.ordering.push('duplicate-claim');
    expect(() => renderAtomicDraftV1(duplicate)).toThrow('RENDER_FAILED');

    const presentation = rendererInput();
    presentation.verification.claims[0].canonical_claim_base.fragment.presentation =
      'sentence';
    expect(() => renderAtomicDraftV1(presentation)).toThrow('RENDER_FAILED');
  });
});
