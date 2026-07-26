import {
  type AtomicVerificationResult,
  type SealedApprovedRenderContextV1,
} from './contracts.js';
import { isWellFormedUnicodeScalarV1 } from './well-formed-unicode.js';

export interface AtomicRenderInput {
  verification: AtomicVerificationResult;
  render_context: SealedApprovedRenderContextV1;
}

export interface AtomicRenderResult {
  text: string;
  utf8_byte_length: number;
  utf16_length: number;
  claims: Array<{
    candidate_claim_key: string;
    rendered_claim_text: string;
    output_char_start_utf16: number;
    output_char_end_utf16: number;
    fragment_ordinal: number;
    previous_structure_id: string | null;
    next_structure_id: string | null;
  }>;
}

function renderFailure(): never {
  throw new TypeError('RENDER_FAILED');
}

function hasForbiddenControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function escapePlainTextV1(sourceNfc: string): string {
  if (
    typeof sourceNfc !== 'string' ||
    !isWellFormedUnicodeScalarV1(sourceNfc) ||
    sourceNfc.normalize('NFC') !== sourceNfc ||
    hasForbiddenControl(sourceNfc)
  ) {
    return renderFailure();
  }
  let escaped = '';
  for (const codePoint of sourceNfc) {
    const code = codePoint.codePointAt(0);
    if (
      code !== undefined &&
      ((code >= 0x21 && code <= 0x2f) ||
        (code >= 0x3a && code <= 0x40) ||
        (code >= 0x5b && code <= 0x60) ||
        (code >= 0x7b && code <= 0x7e))
    ) {
      escaped += '\\';
    }
    escaped += codePoint;
  }
  return escaped;
}

function validateContextLabel(label: string): void {
  if (
    typeof label !== 'string' ||
    !isWellFormedUnicodeScalarV1(label) ||
    label.normalize('NFC') !== label ||
    Buffer.byteLength(label, 'utf8') > 200 ||
    hasForbiddenControl(label) ||
    label.includes('<') ||
    label.includes('>') ||
    label.includes('--')
  ) {
    renderFailure();
  }
}

function structureBytes(
  presentation: SealedApprovedRenderContextV1['entries'][number]['presentation'],
  label: string,
): string {
  const escapedLabel = escapePlainTextV1(label);
  switch (presentation) {
    case 'heading_1':
      return `# ${escapedLabel}`;
    case 'heading_2':
      return `## ${escapedLabel}`;
    case 'heading_3':
      return `### ${escapedLabel}`;
    case 'column':
      return `<!-- column:${escapedLabel} -->`;
  }
}

function claimPrefix(
  presentation: 'sentence' | 'bullet' | 'ordered_item',
  paragraphOrdinal: number,
): string {
  const paragraphControl = `<!-- paragraph_key:p${paragraphOrdinal} -->\n`;
  switch (presentation) {
    case 'sentence':
      return paragraphControl;
    case 'bullet':
      return `${paragraphControl}- `;
    case 'ordered_item':
      return `${paragraphControl}1. `;
  }
}

export function renderAtomicDraftV1(
  input: AtomicRenderInput,
): AtomicRenderResult {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.verification !== 'object' ||
    input.verification === null ||
    typeof input.render_context !== 'object' ||
    input.render_context === null
  ) {
    return renderFailure();
  }
  const proposal = input.verification.canonical_proposal;
  if (proposal.status !== 'draft') return renderFailure();

  const contexts = new Map<
    string,
    SealedApprovedRenderContextV1['entries'][number]
  >();
  for (const entry of input.render_context.entries) {
    validateContextLabel(entry.label_nfc);
    if (contexts.has(entry.structure_id)) return renderFailure();
    contexts.set(entry.structure_id, entry);
  }

  const fragments = new Map<
    string,
    (typeof proposal.render_fragments)[number]
  >();
  for (const fragment of proposal.render_fragments) {
    if (fragments.has(fragment.fragment_id)) return renderFailure();
    fragments.set(fragment.fragment_id, fragment);
  }
  if (
    proposal.ordering.length !== fragments.size ||
    new Set(proposal.ordering).size !== proposal.ordering.length
  ) {
    return renderFailure();
  }

  const proposalClaims = new Map(
    proposal.claims.map((claim) => [claim.proposal_claim_id, claim]),
  );
  if (proposalClaims.size !== proposal.claims.length) return renderFailure();
  const verifiedByOrdinal = new Map(
    input.verification.claims.map((claim) => [
      claim.canonical_claim_base.fragment.ordinal,
      claim,
    ]),
  );
  if (verifiedByOrdinal.size !== input.verification.claims.length) {
    return renderFailure();
  }

  let text = '';
  let paragraphOrdinal = 0;
  const consumedClaims = new Set<string>();
  const renderedClaims: AtomicRenderResult['claims'] = [];

  for (let ordinal = 0; ordinal < proposal.ordering.length; ordinal += 1) {
    const fragment = fragments.get(proposal.ordering[ordinal]);
    if (!fragment) return renderFailure();
    switch (fragment.kind) {
      case 'separator':
        switch (fragment.token) {
          case 'space':
            text += ' ';
            break;
          case 'line_break':
            text += '\n';
            break;
          case 'paragraph_break':
            text += '\n\n';
            break;
          default:
            return renderFailure();
        }
        break;
      case 'structure_ref': {
        const context = contexts.get(fragment.structure_id);
        if (!context || context.presentation !== fragment.presentation) {
          return renderFailure();
        }
        text += structureBytes(context.presentation, context.label_nfc);
        break;
      }
      case 'claim_ref': {
        const proposalClaim = proposalClaims.get(fragment.claim_id);
        const verifiedClaim = verifiedByOrdinal.get(ordinal);
        if (
          !proposalClaim ||
          !verifiedClaim ||
          consumedClaims.has(fragment.claim_id) ||
          verifiedClaim.canonical_claim_base.source_claim_text_nfc !==
            proposalClaim.claim_text ||
          verifiedClaim.canonical_claim_base.fragment.presentation !==
            fragment.presentation
        ) {
          return renderFailure();
        }
        consumedClaims.add(fragment.claim_id);
        paragraphOrdinal += 1;
        text += claimPrefix(fragment.presentation, paragraphOrdinal);
        const renderedClaimText = escapePlainTextV1(
          verifiedClaim.canonical_claim_base.source_claim_text_nfc,
        );
        const outputStart = text.length;
        text += renderedClaimText;
        renderedClaims.push({
          candidate_claim_key: verifiedClaim.candidate_claim_key,
          rendered_claim_text: renderedClaimText,
          output_char_start_utf16: outputStart,
          output_char_end_utf16: text.length,
          fragment_ordinal: ordinal,
          previous_structure_id:
            verifiedClaim.canonical_claim_base.fragment.previous_structure_id,
          next_structure_id:
            verifiedClaim.canonical_claim_base.fragment.next_structure_id,
        });
        break;
      }
      default:
        return renderFailure();
    }
  }

  if (
    consumedClaims.size !== proposal.claims.length ||
    renderedClaims.length !== input.verification.claims.length
  ) {
    return renderFailure();
  }
  return {
    text,
    utf8_byte_length: Buffer.byteLength(text, 'utf8'),
    utf16_length: text.length,
    claims: renderedClaims,
  };
}
