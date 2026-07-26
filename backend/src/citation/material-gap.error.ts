export class MaterialGapError extends Error {
  readonly code = 'MATERIAL_GAP';

  constructor(
    message: string,
    readonly unsupportedClaimIds: string[] = [],
  ) {
    super(message);
    this.name = 'MaterialGapError';
  }
}

export class GroundingRevisionRequiredError extends Error {
  readonly code = 'GROUNDING_REVISION_REQUIRED';
  readonly unsupportedClaims: Array<{
    claim_id: string;
    claim_text: string;
  }>;
  readonly unsupportedClaimIds: string[];

  constructor(
    unsupportedClaims:
      | string[]
      | Array<{ claim_id: string; claim_text: string }> = [],
  ) {
    super('关键声明需要定向检索或修订后才能保存');
    this.name = 'GroundingRevisionRequiredError';
    this.unsupportedClaims = unsupportedClaims.map(
      (claim: string | { claim_id: string; claim_text: string }) =>
        typeof claim === 'string'
          ? { claim_id: claim, claim_text: '' }
          : { claim_id: claim.claim_id, claim_text: claim.claim_text },
    );
    this.unsupportedClaimIds = this.unsupportedClaims.map(
      (claim) => claim.claim_id,
    );
  }
}
