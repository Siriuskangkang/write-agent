import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CitationMap } from './entities/citation-map.entity.js';
import { ProjectState } from '../project/entities/project-state.entity.js';
import { CitationUseType } from '../common/enums.js';
import { ProjectAccessPolicy } from '../project/project-access.policy.js';
import {
  formatCitationReference,
  renderGbt7714Ledger,
} from './citation-format.js';
import {
  toPublicCitation,
  type PublicCitationDto,
  type PublicCitationInput,
} from './dto/citation-response.dto.js';
import { capPersistedGroundingForRead } from './grounding-read-policy.js';

export interface CreateCitationInput {
  paragraph_key: string;
  chunk_id: string;
  file_id: string;
  use_type: CitationUseType;
  evidence_text: string;
  page_number?: number | null;
  section_title?: string | null;
  confidence_score?: number;
}

export interface CitationSourceFileRow {
  file_name: string | null;
  file_type: string | null;
}

export interface PublicCitationLedgerDto {
  citations: Array<PublicCitationDto & { reference_number: number | null }>;
  references: Array<{ number: number; file_id: string; text: string }>;
  claim_links: Array<{ claim_id: string; reference_number: number }>;
}

@Injectable()
export class CitationService {
  private readonly logger = new Logger(CitationService.name);

  constructor(
    @InjectRepository(CitationMap)
    private readonly citationRepo: Repository<CitationMap>,
    @InjectRepository(ProjectState)
    private readonly projectStateRepo: Repository<ProjectState>,
    private readonly projectAccessPolicy: ProjectAccessPolicy,
  ) {}

  async createCitations(
    projectId: string,
    resultId: string,
    citations: CreateCitationInput[],
  ): Promise<CitationMap[]> {
    if (citations.length === 0) return [];

    const entities = citations.map((c) =>
      this.citationRepo.create({
        project_id: projectId,
        result_id: resultId,
        paragraph_key: c.paragraph_key,
        chunk_id: c.chunk_id,
        file_id: c.file_id,
        use_type: c.use_type,
        evidence_text: c.evidence_text,
        page_number: c.page_number ?? null,
        section_title: c.section_title ?? null,
        confidence_score: c.confidence_score ?? 0,
      }),
    );

    const saved = await this.citationRepo.save(entities);
    this.logger.log(`Created ${saved.length} citations for result ${resultId}`);
    return saved;
  }

  async getCitationsByResultId(
    userId: string,
    projectId: string,
    resultId: string,
  ): Promise<PublicCitationDto[]> {
    await this.projectAccessPolicy.assertOwner(userId, projectId);
    await this.assertWritingResult(projectId, resultId);
    const rows = await this.citationRepo
      .createQueryBuilder('c')
      .leftJoin('source_files', 'sf', 'sf.id = c.file_id')
      .leftJoin('grounding_claims', 'gc', 'gc.claim_id = c.claim_id')
      .leftJoin(
        'grounding_assignments',
        'ga',
        'ga.workflow_job_id = gc.workflow_job_id AND ga.project_id = gc.project_id',
      )
      .leftJoin('chunks', 'ch', 'ch.id = c.chunk_id')
      .addSelect('sf.file_name', 'file_name')
      .addSelect('sf.file_type', 'file_type')
      .addSelect('gc.claim_text', 'claim_text')
      .addSelect('gc.output_char_start', 'output_char_start')
      .addSelect('gc.output_char_end', 'output_char_end')
      .addSelect('ga.contract_version', 'contract_version')
      .addSelect('gc.atomic_claim', 'atomic_claim')
      .addSelect('ch.page_start', 'page_start')
      .addSelect('ch.page_end', 'page_end')
      .addSelect('ch.heading_path', 'heading_path')
      .where('c.project_id = :projectId', { projectId })
      .andWhere('c.result_id = :resultId', { resultId })
      .orderBy('c.created_at', 'ASC')
      .getRawAndEntities();

    const sourceFileRows = rows.raw as CitationSourceFileRow[];

    return rows.entities.map((entity, i) => {
      const file_name = sourceFileRows[i]?.file_name ?? null;
      const file_type = sourceFileRows[i]?.file_type ?? null;
      const persisted = sourceFileRows[i] as unknown as Record<string, unknown>;
      const readVerdict = capPersistedGroundingForRead({
        contract_version: persisted.contract_version,
        atomic_claim: persisted.atomic_claim,
        support_status: entity.support_status,
        support_score: entity.support_score,
        verification_method: entity.verification_method,
      });

      return toPublicCitation({
        ...entity,
        ...readVerdict,
        file_name,
        file_type,
        claim_text: asOptionalString(sourceFileRows[i]?.['claim_text']),
        output_char_start: asOptionalNumber(
          sourceFileRows[i]?.['output_char_start'],
        ),
        output_char_end: asOptionalNumber(
          sourceFileRows[i]?.['output_char_end'],
        ),
        page_start: asOptionalNumber(sourceFileRows[i]?.['page_start']),
        page_end: asOptionalNumber(sourceFileRows[i]?.['page_end']),
        heading_path: sourceFileRows[i]?.['heading_path'] as unknown,
        reference_text: formatCitationReference({
          file_name,
          file_type,
          section_title: entity.section_title,
          page_number: entity.page_number,
        }),
      } as PublicCitationInput);
    });
  }

  async getCitationById(
    userId: string,
    projectId: string,
    citationId: string,
  ): Promise<PublicCitationDto> {
    await this.projectAccessPolicy.assertOwner(userId, projectId);
    const citation = await this.citationRepo
      .createQueryBuilder('c')
      .leftJoin('source_files', 'sf', 'sf.id = c.file_id')
      .leftJoin('grounding_claims', 'gc', 'gc.claim_id = c.claim_id')
      .leftJoin(
        'grounding_assignments',
        'ga',
        'ga.workflow_job_id = gc.workflow_job_id AND ga.project_id = gc.project_id',
      )
      .leftJoin('chunks', 'ch', 'ch.id = c.chunk_id')
      .addSelect('sf.file_name', 'file_name')
      .addSelect('sf.file_type', 'file_type')
      .addSelect('gc.claim_text', 'claim_text')
      .addSelect('gc.output_char_start', 'output_char_start')
      .addSelect('gc.output_char_end', 'output_char_end')
      .addSelect('ga.contract_version', 'contract_version')
      .addSelect('gc.atomic_claim', 'atomic_claim')
      .addSelect('ch.page_start', 'page_start')
      .addSelect('ch.page_end', 'page_end')
      .addSelect('ch.heading_path', 'heading_path')
      .where('c.id = :citationId', { citationId })
      .andWhere('c.project_id = :projectId', { projectId })
      .getRawAndEntities();
    const entity = citation.entities[0];
    if (!entity) {
      throw new NotFoundException('Citation not found');
    }
    const raw = (citation.raw[0] ?? {}) as Record<string, unknown>;
    const fileName = asOptionalString(raw.file_name);
    const fileType = asOptionalString(raw.file_type);
    const readVerdict = capPersistedGroundingForRead({
      contract_version: raw.contract_version,
      atomic_claim: raw.atomic_claim,
      support_status: entity.support_status,
      support_score: entity.support_score,
      verification_method: entity.verification_method,
    });
    return toPublicCitation({
      ...entity,
      ...readVerdict,
      file_name: fileName,
      file_type: fileType,
      claim_text: asOptionalString(raw.claim_text),
      output_char_start: asOptionalNumber(raw.output_char_start),
      output_char_end: asOptionalNumber(raw.output_char_end),
      page_start: asOptionalNumber(raw.page_start),
      page_end: asOptionalNumber(raw.page_end),
      heading_path: raw.heading_path,
      reference_text: formatCitationReference({
        file_name: fileName,
        file_type: fileType,
        section_title: entity.section_title,
        page_number: entity.page_number,
      }),
    } as PublicCitationInput);
  }

  async getCitationLedgerByResultId(
    userId: string,
    projectId: string,
    resultId: string,
  ): Promise<PublicCitationLedgerDto> {
    const citations = await this.getCitationsByResultId(
      userId,
      projectId,
      resultId,
    );
    return buildPublicCitationLedger(citations);
  }

  async markMaterialGap(
    userId: string,
    projectId: string,
    resultId: string,
    reason: string,
  ): Promise<ProjectState> {
    await this.projectAccessPolicy.assertOwner(userId, projectId);
    await this.assertWritingResult(projectId, resultId);
    const state = await this.projectStateRepo.findOne({
      where: { project_id: projectId },
    });
    if (!state) {
      throw new NotFoundException(
        `ProjectState not found for project ${projectId}`,
      );
    }

    const gaps = Array.isArray(state.material_gaps) ? state.material_gaps : [];
    gaps.push({
      reason,
      result_id: resultId,
      created_at: new Date().toISOString(),
    });
    state.material_gaps = gaps;

    const saved = await this.projectStateRepo.save(state);
    this.logger.log(
      `Marked material gap for project ${projectId}, result ${resultId}`,
    );
    return saved;
  }

  private async assertWritingResult(
    projectId: string,
    resultId: string,
  ): Promise<void> {
    const rows: unknown = await this.citationRepo.manager.query(
      `SELECT id
         FROM writing_results
        WHERE id = ?
          AND project_id = ?
        LIMIT 1`,
      [resultId, projectId],
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new NotFoundException('写作结果不存在');
    }
  }
}

export function buildPublicCitationLedger(
  citations: PublicCitationDto[],
): PublicCitationLedgerDto {
  const verifiable = citations.filter(
    (
      citation,
    ): citation is PublicCitationDto & {
      claim_id: string;
      claim_text: string;
      output_char_start: number;
    } =>
      citation.claim_id !== null &&
      citation.claim_text !== null &&
      citation.output_char_start !== null,
  );
  const rendered = renderGbt7714Ledger(
    verifiable.map((citation) => ({
      claim_id: citation.claim_id,
      output_char_start: citation.output_char_start,
      file_id: citation.file_id,
      file_name: citation.file_name,
      file_type: citation.file_type,
      section_title: null,
      page_number: citation.page_start,
      page_start: citation.page_start,
      page_end: citation.page_end,
      heading_path: citation.heading_path,
      exact_span_document_start: citation.evidence_char_start,
      exact_span_document_end: citation.evidence_char_end,
    })),
  );
  const numberByClaimAndFile = new Map<string, number>();
  const numberByFile = new Map(
    rendered.references.map((reference) => [
      reference.file_id,
      reference.number,
    ]),
  );
  for (const citation of verifiable) {
    const number = numberByFile.get(citation.file_id);
    if (number !== undefined) {
      numberByClaimAndFile.set(
        `${citation.claim_id}\0${citation.file_id}`,
        number,
      );
    }
  }
  return {
    citations: citations.map((citation) => ({
      ...citation,
      reference_number:
        citation.claim_id === null
          ? null
          : (numberByClaimAndFile.get(
              `${citation.claim_id}\0${citation.file_id}`,
            ) ?? null),
    })),
    references: rendered.references,
    claim_links: rendered.claim_links,
  };
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asOptionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
