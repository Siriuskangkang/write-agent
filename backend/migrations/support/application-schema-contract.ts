import type { QueryRunner } from 'typeorm';
import { findStorageSchemaContractViolations } from './storage-schema-contract';

/**
 * Canonical MySQL 8.4 contract for application-owned tables.
 *
 * Each column signature is:
 * name|column_type|nullability|default|extra|generation_expression
 * |character_set|collation
 *
 * Each index signature is:
 * name|non_unique|index_type|position|column|expression|prefix_length
 * |sort_direction|visibility
 *
 * Each foreign-key signature is:
 * constraint_name|column_position|referenced_position|column|referenced_table
 * |referenced_column|delete_rule|update_rule
 *
 * Each CHECK signature is:
 * constraint_name|enforcement|normalized_check_clause
 *
 * Each table signature requires a base table using InnoDB and
 * utf8mb4/utf8mb4_0900_ai_ci.
 *
 * Authentication tables are validated separately inside the same contract
 * because reconciliation must preserve their data and refuse unsafe drift.
 * Generated marker columns and their indexes are deliberate database-only
 * implementation details for scoped current-version uniqueness.
 */
export const AUTH_TABLES = [
  'users',
  'refresh_tokens',
  'user_settings',
] as const;

export const APPLICATION_TABLES = [
  'file_move_intents',
  'file_cleanup_records',
  'file_upload_outbox',
  'style_templates',
  'export_jobs',
  'citation_maps',
  'content_versions',
  'writing_results',
  'outline_versions',
  'directory_versions',
  'messages',
  'sessions',
  'chunks',
  'documents',
  'source_files',
  'project_states',
  'projects',
] as const;

export const WORKFLOW_TABLES = [
  'workflow_jobs',
  'workflow_events',
  'model_runs',
  'workflow_domain_commits',
] as const;
export const RETRIEVAL_TABLES = [
  'retrieval_runs',
  'retrieval_candidates',
  'retrieval_index_versions',
  'retrieval_run_index_versions',
] as const;
export const GROUNDING_TABLES = [
  'grounding_assignments',
  'grounding_claims',
] as const;
const CANONICAL_TABLES = [
  ...AUTH_TABLES,
  ...APPLICATION_TABLES,
  ...GROUNDING_TABLES,
] as const;
const CANONICAL_TABLE_TYPE = 'BASE TABLE';
const CANONICAL_STORAGE_ENGINE = 'InnoDB';
const CANONICAL_TABLE_COLLATION = 'utf8mb4_0900_ai_ci';
const CANONICAL_CHARACTER_SET = 'utf8mb4';

export const DATABASE_ONLY_COLUMN_ALLOWLIST = [
  {
    table: 'users',
    column: 'avatar_url',
    reason: 'preserved authentication compatibility column',
  },
  {
    table: 'projects',
    column: 'active_style_template_id',
    reason: 'migration-managed style pointer compatibility column',
  },
  {
    table: 'directory_versions',
    column: 'current_marker',
    reason: 'generated current-version uniqueness marker',
  },
  {
    table: 'outline_versions',
    column: 'scope_section_node_id',
    reason: 'generated nullable scope normalization marker',
  },
  {
    table: 'outline_versions',
    column: 'current_marker',
    reason: 'generated current-version uniqueness marker',
  },
  {
    table: 'content_versions',
    column: 'current_marker',
    reason: 'generated current-version uniqueness marker',
  },
  {
    table: 'documents',
    column: 'active_marker',
    reason: 'generated active-ingestion uniqueness marker',
  },
] as const;

export const SERVER_UUID_DEFAULT_ALLOWLIST = [
  'users',
  'refresh_tokens',
  ...APPLICATION_TABLES,
  'workflow_jobs',
  'workflow_events',
  'model_runs',
  'retrieval_runs',
  'retrieval_candidates',
  'retrieval_index_versions',
  'retrieval_run_index_versions',
] as const;

const EXPECTED_COLUMNS: Readonly<Record<string, string>> = {
  users:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;email|varchar(255)|NO|∅||;password_hash|varchar(255)|NO|∅||;nickname|varchar(100)|YES|∅||;avatar_url|varchar(500)|YES|∅||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|;updated_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED on update CURRENT_TIMESTAMP|',
  refresh_tokens:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;user_id|varchar(36)|NO|∅||;token_hash|varchar(255)|NO|∅||;expires_at|datetime|NO|∅||;revoked_at|datetime|YES|∅||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  user_settings:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;user_id|varchar(36)|NO|∅||;settings|json|YES|∅||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|;updated_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED on update CURRENT_TIMESTAMP|',
  file_move_intents:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;status|varchar(20)|NO|ACTIVE||;source_path|varchar(1000)|NO|∅||;destination_path|varchar(1000)|NO|∅||;file_id|varchar(36)|NO|∅||;project_id|varchar(36)|NO|∅||;user_id|varchar(36)|NO|∅||;file_size|bigint|NO|∅||;writer_token|varchar(100)|NO|∅||;recover_after|timestamp(6)|NO|∅||;attempts|int|NO|0||;last_error|text|YES|∅||;lease_owner|varchar(100)|YES|∅||;lease_expires_at|timestamp(6)|YES|∅||;next_attempt_at|timestamp(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED|;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  file_cleanup_records:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;file_path|varchar(1000)|NO|∅||;reason|text|NO|∅||;status|varchar(20)|NO|pending||;attempts|int|NO|0||;last_error|text|YES|∅||;lease_owner|varchar(100)|YES|∅||;lease_expires_at|timestamp(6)|YES|∅||;next_attempt_at|timestamp(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED|;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  file_upload_outbox:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;file_id|varchar(36)|NO|∅||;project_id|varchar(36)|NO|∅||;parse_generation|int|NO|1||;job_id|varchar(100)|NO|∅||;status|varchar(20)|NO|pending||;attempts|int|NO|0||;last_error|text|YES|∅||;lease_owner|varchar(100)|YES|∅||;lease_expires_at|timestamp(6)|YES|∅||;next_attempt_at|timestamp(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED|;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  style_templates:
    "id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;name|varchar(255)|NO|∅||;file_path|varchar(1024)|YES|∅||;reference_file_ids|json|YES|∅||;features|json|YES|∅||;status|enum('pending','analyzing','completed','failed')|NO|pending||;error_message|text|YES|∅||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|;updated_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED on update CURRENT_TIMESTAMP|",
  export_jobs:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;format|varchar(20)|NO|∅||;scope|varchar(20)|NO|∅||;chapter_ids|json|YES|∅||;include_citations|tinyint(1)|NO|1||;status|varchar(20)|NO|pending||;file_path|varchar(1000)|YES|∅||;error_message|text|YES|∅||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|;completed_at|datetime|YES|∅||',
  citation_maps:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;result_id|varchar(36)|NO|∅||;paragraph_key|varchar(200)|NO|∅||;chunk_id|varchar(36)|NO|∅||;file_id|varchar(36)|NO|∅||;use_type|varchar(30)|NO|∅||;evidence_text|text|NO|∅||;page_number|int|YES|∅||;section_title|varchar(500)|YES|∅||;confidence_score|float|NO|0||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|;claim_id|char(64)|YES|∅||;evidence_id|varchar(100)|YES|∅||;document_id|varchar(36)|YES|∅||;retrieval_run_id|varchar(36)|YES|∅||;support_status|varchar(20)|NO|UNVERIFIABLE||;support_score|double|NO|0||;verification_method|varchar(50)|NO|legacy_unverifiable||;evidence_char_start|int|YES|∅||;evidence_char_end|int|YES|∅||;chunk_char_start|int|YES|∅||;chunk_char_end|int|YES|∅||;candidate_rank|int|YES|∅||;sparse_rank|int|YES|∅||;dense_rank|int|YES|∅||;fusion_rank|int|YES|∅||;rerank_rank|int|YES|∅||;sparse_score|double|YES|∅||;dense_score|double|YES|∅||;fusion_score|double|YES|∅||;rerank_score|double|YES|∅||;ingestion_key|char(64)|YES|∅||;index_snapshot|json|YES|∅||;snapshot_digest|char(64)|YES|∅||',
  content_versions:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;result_id|varchar(36)|NO|∅||;version_number|int|NO|∅||;editor_source|varchar(20)|NO|ai||;content_text|mediumtext|NO|∅||;is_current|tinyint(1)|NO|0||;current_marker|tinyint|YES|∅|STORED GENERATED|(case when (`is_current` = 1) then 1 else NULL end);created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  writing_results:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;session_id|varchar(36)|YES|∅||;chapter_node_id|varchar(100)|YES|∅||;section_node_id|varchar(100)|YES|∅||;chapter_index|int|YES|∅||;chapter_title|varchar(500)|YES|∅||;section_title|varchar(500)|YES|∅||;task_type|varchar(30)|NO|∅||;status|varchar(20)|NO|streaming||;content_text|mediumtext|NO|∅||;word_count|int|YES|∅||;style|varchar(50)|YES|∅||;version_number|int|NO|1||;parent_result_id|varchar(36)|YES|∅||;error_message|text|YES|∅||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|;completed_at|datetime|YES|∅||',
  outline_versions:
    "id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;chapter_node_id|varchar(100)|NO|∅||;section_node_id|varchar(100)|YES|∅||;chapter_index|int|NO|∅||;chapter_title|varchar(500)|NO|∅||;version_number|int|NO|∅||;content|json|NO|∅||;is_current|tinyint(1)|NO|0||;scope_section_node_id|varchar(100)|YES|∅|STORED GENERATED|coalesce(`section_node_id`,_utf8mb4\\'\\');current_marker|tinyint|YES|∅|STORED GENERATED|(case when (`is_current` = 1) then 1 else NULL end);created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|",
  directory_versions:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;version_number|int|NO|∅||;content|json|NO|∅||;is_current|tinyint(1)|NO|0||;current_marker|tinyint|YES|∅|STORED GENERATED|(case when (`is_current` = 1) then 1 else NULL end);created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  messages:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;session_id|varchar(36)|NO|∅||;role|varchar(20)|NO|∅||;content|text|NO|∅||;message_type|varchar(30)|NO|chat||;metadata|json|YES|∅||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  sessions:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;user_id|varchar(36)|NO|∅||;title|varchar(255)|NO|新会话||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|;updated_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED on update CURRENT_TIMESTAMP|',
  chunks:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;file_id|varchar(36)|NO|∅||;document_id|varchar(36)|NO|∅||;chunk_index|int|NO|∅||;content|longtext|NO|∅||;search_text|longtext|NO|∅||;section_title|varchar(500)|YES|∅||;page_number|int|YES|∅||;keywords|json|YES|∅||;search_terms|json|YES|∅||;stable_key|char(64)|YES|∅||;ingestion_key|char(64)|YES|∅||;chunk_type|varchar(20)|NO|child||;parent_id|varchar(36)|YES|∅||;position|int|NO|0||;token_count|int|NO|0||;tokenizer_version|varchar(50)|NO|legacy-char-v1||;overlap_previous_tokens|int|NO|0||;heading_path|json|YES|∅||;page_start|int|YES|∅||;page_end|int|YES|∅||;block_ids|json|YES|∅||;char_start|int|YES|∅||;char_end|int|YES|∅||;is_active|tinyint(1)|NO|1||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  documents:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;file_id|varchar(36)|NO|∅||;project_id|varchar(36)|NO|∅||;title|varchar(500)|YES|∅||;content_text|mediumtext|YES|∅||;page_count|int|YES|∅||;sections|json|YES|∅||;source_checksum|char(64)|NO|∅||;parser_version|varchar(50)|NO|∅||;chunk_version|varchar(50)|NO|∅||;ingestion_key|char(64)|NO|∅||;ast|json|NO|∅||;is_active|tinyint(1)|NO|0||;active_marker|tinyint|YES|∅|STORED GENERATED|(case when (`is_active` = 1) then 1 else NULL end);parsed_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  source_files:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;file_name|varchar(500)|NO|∅||;file_type|varchar(20)|NO|∅||;file_size|bigint|YES|∅||;file_path|varchar(1000)|NO|∅||;checksum_sha256|char(64)|YES|∅||;active_ingestion_key|char(64)|YES|∅||;parse_generation|int|NO|1||;parse_attempt_token|char(36)|YES|∅||;parse_lease_expires_at|datetime(6)|YES|∅||;parse_status|varchar(20)|NO|pending||;error_message|text|YES|∅||;uploaded_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  project_states:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;current_directory_version_id|varchar(36)|YES|∅||;completed_chapters|json|NO|∅||;in_progress_chapter|varchar(255)|YES|∅||;in_progress_section|varchar(255)|YES|∅||;pending_items|json|NO|∅||;material_gaps|json|NO|∅||;user_notes|text|YES|∅||;updated_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED on update CURRENT_TIMESTAMP|',
  projects:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;user_id|varchar(36)|NO|∅||;name|varchar(255)|NO|∅||;type|varchar(50)|YES|∅||;target_audience|text|YES|∅||;target_chapters|int|NO|10||;style|varchar(50)|NO|教材||;status|varchar(20)|NO|draft||;description|text|YES|∅||;active_style_template_id|varchar(36)|YES|∅||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|;updated_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED on update CURRENT_TIMESTAMP|',
  grounding_assignments:
    'workflow_job_id|varchar(36)|NO|∅||;project_id|varchar(36)|NO|∅||;retrieval_run_id|varchar(36)|NO|∅||;retrieval_state|varchar(20)|NO|∅||;retrieval_run_refs|json|NO|∅||;evidence_ids|json|NO|∅||;snapshot_digest|char(64)|YES|∅||;strict_mode|tinyint(1)|NO|1||;targeted_revision_attempts|int unsigned|NO|0||;created_at|datetime(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED|;updated_at|datetime(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)|;contract_version|varchar(32)|NO|legacy:v0||',
  grounding_claims:
    'claim_id|char(64)|NO|∅||;workflow_job_id|varchar(36)|NO|∅||;project_id|varchar(36)|NO|∅||;result_id|varchar(36)|NO|∅||;claim_text|text|NO|∅||;normalized_claim_text|text|NO|∅||;output_char_start|int unsigned|NO|∅||;output_char_end|int unsigned|NO|∅||;support_status|varchar(20)|NO|∅||;support_score|double|NO|0||;verification_method|varchar(50)|NO|∅||;created_at|datetime(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED|;atomic_claim|json|YES|∅||',
};

const PRE_STRUCTURED_COLUMNS: Readonly<Record<string, string>> = {
  file_upload_outbox:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;file_id|varchar(36)|NO|∅||;project_id|varchar(36)|NO|∅||;job_id|varchar(100)|NO|∅||;status|varchar(20)|NO|pending||;attempts|int|NO|0||;last_error|text|YES|∅||;lease_owner|varchar(100)|YES|∅||;lease_expires_at|timestamp(6)|YES|∅||;next_attempt_at|timestamp(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED|;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  chunks:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;file_id|varchar(36)|NO|∅||;document_id|varchar(36)|NO|∅||;chunk_index|int|NO|∅||;content|text|NO|∅||;section_title|varchar(500)|YES|∅||;page_number|int|YES|∅||;keywords|json|YES|∅||;search_terms|json|YES|∅||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  documents:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;file_id|varchar(36)|NO|∅||;project_id|varchar(36)|NO|∅||;title|varchar(500)|YES|∅||;content_text|text|YES|∅||;page_count|int|YES|∅||;sections|json|YES|∅||;parsed_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  source_files:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;file_name|varchar(500)|NO|∅||;file_type|varchar(20)|NO|∅||;file_size|bigint|YES|∅||;file_path|varchar(1000)|NO|∅||;parse_status|varchar(20)|NO|pending||;error_message|text|YES|∅||;uploaded_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
};

const PRE_HYBRID_COLUMNS: Readonly<Record<string, string>> = {
  chunks:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;file_id|varchar(36)|NO|∅||;document_id|varchar(36)|NO|∅||;chunk_index|int|NO|∅||;content|text|NO|∅||;section_title|varchar(500)|YES|∅||;page_number|int|YES|∅||;keywords|json|YES|∅||;search_terms|json|YES|∅||;stable_key|char(64)|YES|∅||;ingestion_key|char(64)|YES|∅||;chunk_type|varchar(20)|NO|child||;parent_id|varchar(36)|YES|∅||;position|int|NO|0||;token_count|int|NO|0||;tokenizer_version|varchar(50)|NO|legacy-char-v1||;overlap_previous_tokens|int|NO|0||;heading_path|json|YES|∅||;page_start|int|YES|∅||;page_end|int|YES|∅||;block_ids|json|YES|∅||;char_start|int|YES|∅||;char_end|int|YES|∅||;is_active|tinyint(1)|NO|1||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
};

const PRE_GROUNDING_COLUMNS: Readonly<Record<string, string>> = {
  citation_maps:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;result_id|varchar(36)|NO|∅||;paragraph_key|varchar(200)|NO|∅||;chunk_id|varchar(36)|NO|∅||;file_id|varchar(36)|NO|∅||;use_type|varchar(30)|NO|∅||;evidence_text|text|NO|∅||;page_number|int|YES|∅||;section_title|varchar(500)|YES|∅||;confidence_score|float|NO|0||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
};

const PRE_AUTHORING_BODY_COLUMNS: Readonly<Record<string, string>> = {
  content_versions:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;result_id|varchar(36)|NO|∅||;version_number|int|NO|∅||;editor_source|varchar(20)|NO|ai||;content_text|text|NO|∅||;is_current|tinyint(1)|NO|0||;current_marker|tinyint|YES|∅|STORED GENERATED|(case when (`is_current` = 1) then 1 else NULL end);created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  writing_results:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;session_id|varchar(36)|YES|∅||;chapter_node_id|varchar(100)|YES|∅||;section_node_id|varchar(100)|YES|∅||;chapter_index|int|YES|∅||;chapter_title|varchar(500)|YES|∅||;section_title|varchar(500)|YES|∅||;task_type|varchar(30)|NO|∅||;status|varchar(20)|NO|streaming||;content_text|text|NO|∅||;word_count|int|YES|∅||;style|varchar(50)|YES|∅||;version_number|int|NO|1||;parent_result_id|varchar(36)|YES|∅||;error_message|text|YES|∅||;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|;completed_at|datetime|YES|∅||',
};

const STORAGE_EXPECTED_COLUMNS: Readonly<Record<string, string>> = {
  file_upload_outbox:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;file_id|varchar(36)|NO|∅||;project_id|varchar(36)|NO|∅||;parse_generation|int|NO|1||;storage_intent_id|varchar(36)|YES|∅||;job_id|varchar(100)|NO|∅||;status|varchar(20)|NO|pending||;attempts|int|NO|0||;last_error|text|YES|∅||;lease_owner|varchar(100)|YES|∅||;lease_expires_at|timestamp(6)|YES|∅||;next_attempt_at|timestamp(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED|;created_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
  source_files:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;project_id|varchar(36)|NO|∅||;file_name|varchar(500)|NO|∅||;file_type|varchar(20)|NO|∅||;file_size|bigint|YES|∅||;file_path|varchar(1000)|NO|∅||;checksum_sha256|char(64)|YES|∅||;active_ingestion_key|char(64)|YES|∅||;parse_generation|int|NO|1||;parse_attempt_token|char(36)|YES|∅||;parse_lease_expires_at|datetime(6)|YES|∅||;parse_status|varchar(20)|NO|pending||;error_message|text|YES|∅||;deleted_at|datetime(6)|YES|∅||;deleted_by|varchar(36)|YES|∅||;uploaded_at|datetime|NO|CURRENT_TIMESTAMP|DEFAULT_GENERATED|',
};

const EXPECTED_INDEXES: Readonly<Record<string, string>> = {
  users: 'PRIMARY|0|BTREE|1|id;uq_users_email|0|BTREE|1|email',
  refresh_tokens:
    'idx_refresh_tokens_user_id|1|BTREE|1|user_id;PRIMARY|0|BTREE|1|id',
  user_settings:
    'PRIMARY|0|BTREE|1|id;uq_user_settings_user_id|0|BTREE|1|user_id',
  file_move_intents:
    'idx_file_move_intents_claim|1|BTREE|1|status;idx_file_move_intents_claim|1|BTREE|2|recover_after;idx_file_move_intents_claim|1|BTREE|3|next_attempt_at;idx_file_move_intents_claim|1|BTREE|4|lease_expires_at;PRIMARY|0|BTREE|1|id;uq_file_move_intents_file|0|BTREE|1|file_id',
  file_cleanup_records:
    'idx_file_cleanup_records_claim|1|BTREE|1|status;idx_file_cleanup_records_claim|1|BTREE|2|next_attempt_at;idx_file_cleanup_records_claim|1|BTREE|3|lease_expires_at;PRIMARY|0|BTREE|1|id',
  file_upload_outbox:
    'idx_file_upload_outbox_claim|1|BTREE|1|status;idx_file_upload_outbox_claim|1|BTREE|2|next_attempt_at;idx_file_upload_outbox_claim|1|BTREE|3|lease_expires_at;PRIMARY|0|BTREE|1|id;uq_file_upload_outbox_file|0|BTREE|1|file_id;uq_file_upload_outbox_job|0|BTREE|1|job_id',
  style_templates:
    'idx_style_templates_project_id|1|BTREE|1|project_id;idx_style_templates_status|1|BTREE|1|status;PRIMARY|0|BTREE|1|id',
  export_jobs:
    'idx_export_jobs_project_id|1|BTREE|1|project_id;PRIMARY|0|BTREE|1|id',
  citation_maps:
    'idx_citation_maps_chunk_id|1|BTREE|1|chunk_id;idx_citation_maps_claim|1|BTREE|1|claim_id;idx_citation_maps_file_id|1|BTREE|1|file_id;idx_citation_maps_project_id|1|BTREE|1|project_id;idx_citation_maps_result_id|1|BTREE|1|result_id;idx_citation_maps_retrieval|1|BTREE|1|retrieval_run_id;PRIMARY|0|BTREE|1|id',
  content_versions:
    'idx_content_versions_result_id|1|BTREE|1|result_id;PRIMARY|0|BTREE|1|id;uq_content_versions_current|0|BTREE|1|result_id;uq_content_versions_current|0|BTREE|2|current_marker;uq_content_versions_scope_version|0|BTREE|1|result_id;uq_content_versions_scope_version|0|BTREE|2|version_number',
  writing_results:
    'idx_writing_results_chapter|1|BTREE|1|project_id;idx_writing_results_chapter|1|BTREE|2|chapter_node_id;idx_writing_results_project_id|1|BTREE|1|project_id;idx_writing_results_session_id|1|BTREE|1|session_id;PRIMARY|0|BTREE|1|id',
  outline_versions:
    'idx_outline_versions_project_chapter_section|1|BTREE|1|project_id;idx_outline_versions_project_chapter_section|1|BTREE|2|chapter_node_id;idx_outline_versions_project_chapter_section|1|BTREE|3|section_node_id;idx_outline_versions_project_id|1|BTREE|1|project_id;idx_outline_versions_scope|1|BTREE|1|project_id;idx_outline_versions_scope|1|BTREE|2|chapter_node_id;idx_outline_versions_scope|1|BTREE|3|scope_section_node_id;PRIMARY|0|BTREE|1|id;uq_outline_versions_current|0|BTREE|1|project_id;uq_outline_versions_current|0|BTREE|2|chapter_node_id;uq_outline_versions_current|0|BTREE|3|scope_section_node_id;uq_outline_versions_current|0|BTREE|4|current_marker;uq_outline_versions_scope_version|0|BTREE|1|project_id;uq_outline_versions_scope_version|0|BTREE|2|chapter_node_id;uq_outline_versions_scope_version|0|BTREE|3|scope_section_node_id;uq_outline_versions_scope_version|0|BTREE|4|version_number',
  directory_versions:
    'idx_directory_versions_project_id|1|BTREE|1|project_id;PRIMARY|0|BTREE|1|id;uq_directory_versions_current|0|BTREE|1|project_id;uq_directory_versions_current|0|BTREE|2|current_marker;uq_directory_versions_scope_version|0|BTREE|1|project_id;uq_directory_versions_scope_version|0|BTREE|2|version_number',
  messages: 'idx_messages_session_id|1|BTREE|1|session_id;PRIMARY|0|BTREE|1|id',
  sessions:
    'idx_sessions_project_id|1|BTREE|1|project_id;idx_sessions_user_id|1|BTREE|1|user_id;PRIMARY|0|BTREE|1|id',
  chunks:
    'idx_chunks_active_children|1|BTREE|1|project_id;idx_chunks_active_children|1|BTREE|2|is_active;idx_chunks_active_children|1|BTREE|3|chunk_type;idx_chunks_file_id|1|BTREE|1|file_id;idx_chunks_parent_id|1|BTREE|1|parent_id;idx_chunks_project_id|1|BTREE|1|project_id;idx_chunks_search_fulltext|1|FULLTEXT|1|search_text;PRIMARY|0|BTREE|1|id;uq_chunks_document_stable_key|0|BTREE|1|document_id;uq_chunks_document_stable_key|0|BTREE|2|stable_key',
  documents:
    'idx_documents_file_id|1|BTREE|1|file_id;idx_documents_project_active|1|BTREE|1|project_id;idx_documents_project_active|1|BTREE|2|is_active;idx_documents_project_id|1|BTREE|1|project_id;PRIMARY|0|BTREE|1|id;uq_documents_file_active|0|BTREE|1|file_id;uq_documents_file_active|0|BTREE|2|active_marker;uq_documents_file_ingestion|0|BTREE|1|file_id;uq_documents_file_ingestion|0|BTREE|2|ingestion_key',
  source_files:
    'idx_source_files_checksum|1|BTREE|1|checksum_sha256;idx_source_files_parse_status|1|BTREE|1|parse_status;idx_source_files_project_id|1|BTREE|1|project_id;idx_source_files_uploaded_at|1|BTREE|1|uploaded_at;PRIMARY|0|BTREE|1|id',
  project_states:
    'PRIMARY|0|BTREE|1|id;project_states_current_directory_version_id_fkey|1|BTREE|1|current_directory_version_id;uq_project_states_project_id|0|BTREE|1|project_id',
  projects:
    'idx_projects_active_style_template_id|1|BTREE|1|active_style_template_id;idx_projects_user_id|1|BTREE|1|user_id;PRIMARY|0|BTREE|1|id',
  grounding_assignments:
    'idx_grounding_assignments_project|1|BTREE|1|project_id;idx_grounding_assignments_run|1|BTREE|1|retrieval_run_id;PRIMARY|0|BTREE|1|workflow_job_id',
  grounding_claims:
    'idx_grounding_claims_project_result|1|BTREE|1|project_id;idx_grounding_claims_project_result|1|BTREE|2|result_id;idx_grounding_claims_workflow|1|BTREE|1|workflow_job_id;PRIMARY|0|BTREE|1|claim_id;uq_grounding_claims_result_offsets|0|BTREE|1|result_id;uq_grounding_claims_result_offsets|0|BTREE|2|output_char_start;uq_grounding_claims_result_offsets|0|BTREE|3|output_char_end',
};

const PRE_STRUCTURED_INDEXES: Readonly<Record<string, string>> = {
  chunks:
    'chunks_document_id_fkey|1|BTREE|1|document_id;idx_chunks_content_fulltext|1|FULLTEXT|1|content;idx_chunks_file_id|1|BTREE|1|file_id;idx_chunks_project_id|1|BTREE|1|project_id;PRIMARY|0|BTREE|1|id',
  documents:
    'idx_documents_file_id|1|BTREE|1|file_id;idx_documents_project_id|1|BTREE|1|project_id;PRIMARY|0|BTREE|1|id',
  source_files:
    'idx_source_files_parse_status|1|BTREE|1|parse_status;idx_source_files_project_id|1|BTREE|1|project_id;idx_source_files_uploaded_at|1|BTREE|1|uploaded_at;PRIMARY|0|BTREE|1|id',
};

const PRE_HYBRID_INDEXES: Readonly<Record<string, string>> = {
  chunks:
    'idx_chunks_active_children|1|BTREE|1|project_id;idx_chunks_active_children|1|BTREE|2|is_active;idx_chunks_active_children|1|BTREE|3|chunk_type;idx_chunks_content_fulltext|1|FULLTEXT|1|content;idx_chunks_file_id|1|BTREE|1|file_id;idx_chunks_parent_id|1|BTREE|1|parent_id;idx_chunks_project_id|1|BTREE|1|project_id;PRIMARY|0|BTREE|1|id;uq_chunks_document_stable_key|0|BTREE|1|document_id;uq_chunks_document_stable_key|0|BTREE|2|stable_key',
};

const PRE_GROUNDING_INDEXES: Readonly<Record<string, string>> = {
  citation_maps:
    'idx_citation_maps_chunk_id|1|BTREE|1|chunk_id;idx_citation_maps_file_id|1|BTREE|1|file_id;idx_citation_maps_project_id|1|BTREE|1|project_id;idx_citation_maps_result_id|1|BTREE|1|result_id;PRIMARY|0|BTREE|1|id',
};

const STORAGE_EXPECTED_INDEXES: Readonly<Record<string, string>> = {
  file_upload_outbox:
    'idx_file_upload_outbox_claim|1|BTREE|1|status;idx_file_upload_outbox_claim|1|BTREE|2|next_attempt_at;idx_file_upload_outbox_claim|1|BTREE|3|lease_expires_at;idx_file_upload_outbox_storage_intent|1|BTREE|1|storage_intent_id;PRIMARY|0|BTREE|1|id;uq_file_upload_outbox_file|0|BTREE|1|file_id;uq_file_upload_outbox_job|0|BTREE|1|job_id',
  source_files:
    'idx_source_files_checksum|1|BTREE|1|checksum_sha256;idx_source_files_parse_status|1|BTREE|1|parse_status;idx_source_files_project_deleted|1|BTREE|1|project_id;idx_source_files_project_deleted|1|BTREE|2|deleted_at;idx_source_files_project_deleted|1|BTREE|3|id;idx_source_files_project_id|1|BTREE|1|project_id;idx_source_files_uploaded_at|1|BTREE|1|uploaded_at;PRIMARY|0|BTREE|1|id;source_files_deleted_by_fkey|1|BTREE|1|deleted_by;uq_source_files_project_id|0|BTREE|1|project_id;uq_source_files_project_id|0|BTREE|2|id',
};

const EXPECTED_FOREIGN_KEYS: Readonly<Record<string, string>> = {
  users: '',
  refresh_tokens: 'refresh_tokens_user_id_fkey|user_id|users|id|CASCADE',
  user_settings: 'user_settings_user_id_fkey|user_id|users|id|CASCADE',
  file_move_intents: '',
  file_cleanup_records: '',
  file_upload_outbox:
    'file_upload_outbox_file_fkey|file_id|source_files|id|CASCADE',
  style_templates:
    'style_templates_project_id_fkey|project_id|projects|id|CASCADE',
  export_jobs: 'export_jobs_project_id_fkey|project_id|projects|id|CASCADE',
  citation_maps:
    'citation_maps_chunk_id_fkey|chunk_id|chunks|id|CASCADE;citation_maps_claim_fkey|claim_id|grounding_claims|claim_id|CASCADE;citation_maps_file_id_fkey|file_id|source_files|id|CASCADE;citation_maps_project_id_fkey|project_id|projects|id|CASCADE;citation_maps_result_id_fkey|result_id|writing_results|id|CASCADE',
  content_versions:
    'content_versions_result_id_fkey|result_id|writing_results|id|CASCADE',
  writing_results:
    'writing_results_project_id_fkey|project_id|projects|id|CASCADE;writing_results_session_id_fkey|session_id|sessions|id|SET NULL',
  outline_versions:
    'outline_versions_project_id_fkey|project_id|projects|id|CASCADE',
  directory_versions:
    'directory_versions_project_id_fkey|project_id|projects|id|CASCADE',
  messages: 'messages_session_id_fkey|session_id|sessions|id|CASCADE',
  sessions:
    'sessions_project_id_fkey|project_id|projects|id|CASCADE;sessions_user_id_fkey|user_id|users|id|CASCADE',
  chunks:
    'chunks_document_id_fkey|document_id|documents|id|CASCADE;chunks_file_id_fkey|file_id|source_files|id|CASCADE;chunks_parent_id_fkey|parent_id|chunks|id|SET NULL;chunks_project_id_fkey|project_id|projects|id|CASCADE',
  documents:
    'documents_file_id_fkey|file_id|source_files|id|CASCADE;documents_project_id_fkey|project_id|projects|id|CASCADE',
  source_files: 'source_files_project_id_fkey|project_id|projects|id|CASCADE',
  project_states:
    'project_states_current_directory_version_id_fkey|current_directory_version_id|directory_versions|id|SET NULL;project_states_project_id_fkey|project_id|projects|id|CASCADE',
  projects:
    'projects_active_style_template_id_fkey|active_style_template_id|style_templates|id|SET NULL;projects_user_id_fkey|user_id|users|id|CASCADE',
  grounding_assignments:
    'grounding_assignments_project_fkey|project_id|projects|id|CASCADE;grounding_assignments_run_fkey|retrieval_run_id|retrieval_runs|id|RESTRICT;grounding_assignments_workflow_fkey|workflow_job_id|workflow_jobs|id|CASCADE',
  grounding_claims:
    'grounding_claims_project_fkey|project_id|projects|id|CASCADE;grounding_claims_result_fkey|result_id|writing_results|id|CASCADE;grounding_claims_workflow_fkey|workflow_job_id|workflow_jobs|id|RESTRICT',
};

const PRE_STRUCTURED_FOREIGN_KEYS: Readonly<Record<string, string>> = {
  chunks:
    'chunks_document_id_fkey|document_id|documents|id|CASCADE;chunks_file_id_fkey|file_id|source_files|id|CASCADE;chunks_project_id_fkey|project_id|projects|id|CASCADE',
  documents:
    'documents_file_id_fkey|file_id|source_files|id|CASCADE;documents_project_id_fkey|project_id|projects|id|CASCADE',
  source_files: 'source_files_project_id_fkey|project_id|projects|id|CASCADE',
};

const PRE_GROUNDING_FOREIGN_KEYS: Readonly<Record<string, string>> = {
  citation_maps:
    'citation_maps_chunk_id_fkey|chunk_id|chunks|id|CASCADE;citation_maps_file_id_fkey|file_id|source_files|id|CASCADE;citation_maps_project_id_fkey|project_id|projects|id|CASCADE;citation_maps_result_id_fkey|result_id|writing_results|id|CASCADE',
};

const STORAGE_EXPECTED_PHYSICAL_FOREIGN_KEYS: Readonly<
  Record<string, string>
> = {
  file_upload_outbox:
    'file_upload_outbox_file_fkey|1|1|file_id|source_files|id|CASCADE|NO ACTION;file_upload_outbox_storage_intent_fkey|1|1|storage_intent_id|storage_operation_intents|id|RESTRICT|RESTRICT',
  source_files:
    'source_files_deleted_by_fkey|1|1|deleted_by|users|id|RESTRICT|RESTRICT;source_files_project_id_fkey|1|1|project_id|projects|id|RESTRICT|RESTRICT',
};

const STORAGE_EXPECTED_CHECKS: Readonly<Record<string, string>> = {
  file_upload_outbox:
    "chk_file_upload_outbox_storage_intent|YES|(((status='storage_preparing') and (storage_intent_id is null)) or ((status='storage_pending') and (storage_intent_id is not null)) or ((status in ('pending','published')) and (storage_intent_id is null)))",
  source_files:
    'chk_source_files_tombstone|YES|(((deleted_at is null) and (deleted_by is null)) or ((deleted_at is not null) and (deleted_by is not null)))',
};

/**
 * The current canonical schema intentionally has no CHECK constraints.
 *
 * Keep every managed table explicit so a future legitimate CHECK must be
 * reviewed with its name, enforcement state and normalized clause instead of
 * becoming an accidental wildcard.
 */
const EXPECTED_CHECKS: Readonly<Record<string, string>> = {
  users: '',
  refresh_tokens: '',
  user_settings: '',
  file_move_intents: '',
  file_cleanup_records: '',
  file_upload_outbox: '',
  style_templates: '',
  export_jobs: '',
  citation_maps: '',
  content_versions: '',
  writing_results: '',
  outline_versions: '',
  directory_versions: '',
  messages: '',
  sessions: '',
  chunks: '',
  documents: '',
  source_files: '',
  project_states: '',
  projects: '',
  grounding_assignments: '',
  grounding_claims: '',
};

export interface DatabaseOnlyKeyQueryAllowlistEntry {
  table:
    | (typeof CANONICAL_TABLES)[number]
    | (typeof WORKFLOW_TABLES)[number]
    | (typeof RETRIEVAL_TABLES)[number]
    | (typeof GROUNDING_TABLES)[number];
  name: string;
  query: string;
  reason: string;
}

const migrationManagedIndexQueries =
  APPLICATION_TABLES.flatMap<DatabaseOnlyKeyQueryAllowlistEntry>((table) => {
    const names = new Set(
      EXPECTED_INDEXES[table]
        .split(';')
        .map((signature) => signature.split('|')[0])
        .filter((name) => name !== 'PRIMARY'),
    );
    return [...names].map((name) => ({
      table,
      name,
      query: `DROP INDEX \`${name}\` ON \`${table}\``,
      reason:
        'exact canonical application index is validated before TypeORM metadata drift inspection',
    }));
  });

const migrationManagedForeignKeyQueries =
  APPLICATION_TABLES.flatMap<DatabaseOnlyKeyQueryAllowlistEntry>((table) => {
    const signatures = EXPECTED_FOREIGN_KEYS[table];
    if (!signatures) return [];
    const names = signatures
      .split(';')
      .map((signature) => signature.split('|')[0]);
    return names.map((name) => ({
      table,
      name,
      query: `ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``,
      reason:
        'exact canonical application foreign key is validated before TypeORM metadata drift inspection',
    }));
  });

const redundantTypeormApplicationKeyQueries: DatabaseOnlyKeyQueryAllowlistEntry[] =
  [
    {
      table: 'project_states',
      name: 'IDX_76d857335bf49ea4c7b29c7642',
      query:
        'ALTER TABLE `project_states` ADD UNIQUE INDEX `IDX_76d857335bf49ea4c7b29c7642` (`project_id`)',
      reason:
        'TypeORM generated unique metadata duplicates canonical uq_project_states_project_id',
    },
    {
      table: 'file_upload_outbox',
      name: 'IDX_68a96455a3276fe27dda9c8ba0',
      query:
        'ALTER TABLE `file_upload_outbox` ADD UNIQUE INDEX `IDX_68a96455a3276fe27dda9c8ba0` (`file_id`)',
      reason:
        'TypeORM generated unique metadata duplicates canonical uq_file_upload_outbox_file',
    },
    {
      table: 'file_upload_outbox',
      name: 'IDX_010d169b561ef49ad75ebdc9b6',
      query:
        'ALTER TABLE `file_upload_outbox` ADD UNIQUE INDEX `IDX_010d169b561ef49ad75ebdc9b6` (`job_id`)',
      reason:
        'TypeORM generated unique metadata duplicates canonical uq_file_upload_outbox_job',
    },
    {
      table: 'file_move_intents',
      name: 'IDX_48e9d5a9b9eae834b5833768e9',
      query:
        'ALTER TABLE `file_move_intents` ADD UNIQUE INDEX `IDX_48e9d5a9b9eae834b5833768e9` (`file_id`)',
      reason:
        'TypeORM generated unique metadata duplicates canonical uq_file_move_intents_file',
    },
    {
      table: 'project_states',
      name: 'REL_76d857335bf49ea4c7b29c7642',
      query:
        'CREATE UNIQUE INDEX `REL_76d857335bf49ea4c7b29c7642` ON `project_states` (`project_id`)',
      reason:
        'TypeORM one-to-one relation metadata duplicates canonical uq_project_states_project_id',
    },
    {
      table: 'project_states',
      name: 'FK_76d857335bf49ea4c7b29c76421',
      query:
        'ALTER TABLE `project_states` ADD CONSTRAINT `FK_76d857335bf49ea4c7b29c76421` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION',
      reason:
        'TypeORM relation metadata duplicates canonical project_states_project_id_fkey',
    },
    {
      table: 'documents',
      name: 'FK_3d122f6d936acfe13f931d058bf',
      query:
        'ALTER TABLE `documents` ADD CONSTRAINT `FK_3d122f6d936acfe13f931d058bf` FOREIGN KEY (`file_id`) REFERENCES `source_files`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION',
      reason:
        'TypeORM relation metadata duplicates canonical documents_file_id_fkey',
    },
    {
      table: 'style_templates',
      name: 'FK_9461445dc9da5d7f471e5a8de3b',
      query:
        'ALTER TABLE `style_templates` ADD CONSTRAINT `FK_9461445dc9da5d7f471e5a8de3b` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION',
      reason:
        'TypeORM relation metadata duplicates canonical style_templates_project_id_fkey',
    },
    {
      table: 'sessions',
      name: 'FK_d9ea2f57c99bf176e702f2d3aef',
      query:
        'ALTER TABLE `sessions` ADD CONSTRAINT `FK_d9ea2f57c99bf176e702f2d3aef` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION',
      reason:
        'TypeORM relation metadata duplicates canonical sessions_project_id_fkey',
    },
    {
      table: 'messages',
      name: 'FK_ff71b7760071ed9caba7f02beb4',
      query:
        'ALTER TABLE `messages` ADD CONSTRAINT `FK_ff71b7760071ed9caba7f02beb4` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION',
      reason:
        'TypeORM relation metadata duplicates canonical messages_session_id_fkey',
    },
  ];

const preservedAuthKeyQueries: DatabaseOnlyKeyQueryAllowlistEntry[] = [
  {
    table: 'refresh_tokens',
    name: 'refresh_tokens_user_id_fkey',
    query:
      'ALTER TABLE `refresh_tokens` DROP FOREIGN KEY `refresh_tokens_user_id_fkey`',
    reason:
      'exact preserved auth foreign key is validated by the auth contract; the entity intentionally exposes only scalar user_id',
  },
];

const workflowKeyQueries: DatabaseOnlyKeyQueryAllowlistEntry[] = [
  {
    table: 'workflow_jobs',
    name: 'workflow_jobs_user_id_fkey',
    query:
      'ALTER TABLE `workflow_jobs` DROP FOREIGN KEY `workflow_jobs_user_id_fkey`',
    reason:
      'workflow ownership foreign key is migration-managed and validated by the workflow schema contract',
  },
  {
    table: 'workflow_jobs',
    name: 'workflow_jobs_project_id_fkey',
    query:
      'ALTER TABLE `workflow_jobs` DROP FOREIGN KEY `workflow_jobs_project_id_fkey`',
    reason:
      'workflow project foreign key is migration-managed and validated by the workflow schema contract',
  },
  {
    table: 'workflow_events',
    name: 'workflow_events_job_id_fkey',
    query:
      'ALTER TABLE `workflow_events` DROP FOREIGN KEY `workflow_events_job_id_fkey`',
    reason:
      'workflow event cascade is migration-managed and validated by the workflow schema contract',
  },
  {
    table: 'model_runs',
    name: 'model_runs_workflow_job_id_fkey',
    query:
      'ALTER TABLE `model_runs` DROP FOREIGN KEY `model_runs_workflow_job_id_fkey`',
    reason:
      'model-run cascade is migration-managed and validated by the workflow schema contract',
  },
  {
    table: 'workflow_domain_commits',
    name: 'workflow_domain_commits_job_id_fkey',
    query:
      'ALTER TABLE `workflow_domain_commits` DROP FOREIGN KEY `workflow_domain_commits_job_id_fkey`',
    reason:
      'workflow domain commit cascade is migration-managed and validated by its forward migration contract',
  },
];

const retrievalKeyQueries: DatabaseOnlyKeyQueryAllowlistEntry[] = [
  {
    table: 'retrieval_runs',
    name: 'retrieval_runs_workflow_job_id_fkey',
    query:
      'ALTER TABLE `retrieval_runs` DROP FOREIGN KEY `retrieval_runs_workflow_job_id_fkey`',
    reason:
      'targeted retrieval operation ownership is migration-managed and verified by MySQL migration E2E',
  },
  {
    table: 'retrieval_runs',
    name: 'retrieval_runs_project_fkey',
    query:
      'ALTER TABLE `retrieval_runs` DROP FOREIGN KEY `retrieval_runs_project_fkey`',
    reason:
      'retrieval run ownership is enforced by the migration-managed schema',
  },
  {
    table: 'retrieval_candidates',
    name: 'retrieval_candidates_run_fkey',
    query:
      'ALTER TABLE `retrieval_candidates` DROP FOREIGN KEY `retrieval_candidates_run_fkey`',
    reason:
      'retrieval candidate cascade is enforced by the migration-managed schema',
  },
  {
    table: 'retrieval_index_versions',
    name: 'retrieval_index_project_fkey',
    query:
      'ALTER TABLE `retrieval_index_versions` DROP FOREIGN KEY `retrieval_index_project_fkey`',
    reason: 'retrieval index project ownership is migration-managed',
  },
  {
    table: 'retrieval_index_versions',
    name: 'retrieval_index_file_fkey',
    query:
      'ALTER TABLE `retrieval_index_versions` DROP FOREIGN KEY `retrieval_index_file_fkey`',
    reason: 'retrieval index file lifecycle is migration-managed',
  },
  {
    table: 'retrieval_index_versions',
    name: 'retrieval_index_document_fkey',
    query:
      'ALTER TABLE `retrieval_index_versions` DROP FOREIGN KEY `retrieval_index_document_fkey`',
    reason: 'retrieval index document lifecycle is migration-managed',
  },
  {
    table: 'retrieval_run_index_versions',
    name: 'retrieval_run_indexes_run_fkey',
    query:
      'ALTER TABLE `retrieval_run_index_versions` DROP FOREIGN KEY `retrieval_run_indexes_run_fkey`',
    reason:
      'retrieval run index snapshot cascade is migration-managed and validated by the migration E2E contract',
  },
];

const groundingKeyQueries: DatabaseOnlyKeyQueryAllowlistEntry[] = [
  ...[
    ['grounding_assignments_workflow_fkey', 'grounding_assignments'],
    ['grounding_assignments_project_fkey', 'grounding_assignments'],
    ['grounding_assignments_run_fkey', 'grounding_assignments'],
    ['grounding_claims_workflow_fkey', 'grounding_claims'],
    ['grounding_claims_project_fkey', 'grounding_claims'],
    ['grounding_claims_result_fkey', 'grounding_claims'],
  ].map(([name, table]) => ({
    table: table as (typeof GROUNDING_TABLES)[number],
    name,
    query: `ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``,
    reason:
      'claim-evidence ownership and lifecycle foreign key is migration-managed and verified by MySQL migration E2E',
  })),
];

export const DATABASE_ONLY_KEY_QUERY_ALLOWLIST: readonly DatabaseOnlyKeyQueryAllowlistEntry[] =
  [
    ...migrationManagedIndexQueries,
    ...migrationManagedForeignKeyQueries,
    ...redundantTypeormApplicationKeyQueries,
    ...preservedAuthKeyQueries,
    ...workflowKeyQueries,
    ...retrievalKeyQueries,
    ...groundingKeyQueries,
  ];

interface ColumnRow {
  tableName: string;
  columnName: string;
  columnType: string;
  nullable: string;
  defaultValue: unknown;
  extra: string;
  generationExpression: string;
  characterSetName: string | null;
  collationName: string | null;
}

interface TableRow {
  tableName: string;
  tableType: string;
  engine: string | null;
  tableCollation: string | null;
  characterSetName: string | null;
}

interface IndexRow {
  tableName: string;
  indexName: string;
  nonUnique: number | string;
  indexType: string;
  sequenceNumber: number | string;
  columnName: string | null;
  expression: string | null;
  subPart: number | string | null;
  collation: string | null;
  isVisible: string;
}

interface ForeignKeyRow {
  tableName: string;
  constraintName: string;
  sequenceNumber: number | string;
  referencedSequenceNumber: number | string | null;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
  deleteRule: string;
  updateRule: string;
}

interface CheckConstraintRow {
  tableName: string;
  constraintName: string;
  enforced: string;
  checkClause: string;
}

function normalizeNullableInformationSchemaValue(value: unknown): string {
  return value === null || value === undefined ? '∅' : String(value);
}

function hasWrappingParentheses(expression: string): boolean {
  if (!expression.startsWith('(') || !expression.endsWith(')')) return false;

  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote) {
      if (character === '\\' && quote !== '`') {
        index += 1;
      } else if (character === quote) {
        if (expression[index + 1] === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0 && index < expression.length - 1) return false;
    }
  }
  return depth === 0 && quote === null;
}

/**
 * information_schema may preserve harmless outer parentheses and formatting.
 * Normalize those without changing whitespace inside SQL string/identifier
 * literals, so semantically identical server formatting compares stably.
 */
function normalizeCheckClause(rawClause: unknown): string {
  let clause = String(rawClause ?? '')
    .replaceAll('`', '')
    .replace(/_(?:utf8mb4|ascii)/gi, '')
    .replaceAll("\\'", "'")
    .trim();
  while (hasWrappingParentheses(clause)) {
    clause = clause.slice(1, -1).trim();
  }

  let normalized = '';
  let pendingWhitespace = false;
  let quote: "'" | '"' | '`' | null = null;
  for (let index = 0; index < clause.length; index += 1) {
    const character = clause[index];
    if (quote) {
      normalized += character;
      if (character === '\\' && quote !== '`' && index + 1 < clause.length) {
        normalized += clause[index + 1];
        index += 1;
      } else if (character === quote) {
        if (clause[index + 1] === quote) {
          normalized += clause[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      if (pendingWhitespace && normalized.length > 0) normalized += ' ';
      pendingWhitespace = false;
      quote = character;
      normalized += character;
    } else if (/\s/.test(character)) {
      pendingWhitespace = true;
    } else {
      if (pendingWhitespace && normalized.length > 0) normalized += ' ';
      pendingWhitespace = false;
      normalized += character;
    }
  }
  normalized = normalized
    .trim()
    .replace(/\s*([(),=<>])\s*/g, '$1');
  let previous = '';
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized.replace(
      /\(([a-z_][a-z0-9_]*\s+in\s*\([^()]*\))\)/gi,
      '$1',
    );
    normalized = normalized.replace(
      /\(([^()]+)\)/g,
      (match: string, inner: string, offset: number, source: string) => {
        if (/\b(?:and|or)\b/i.test(inner)) return match;
        const prefix = source.slice(0, offset).trimEnd().toLowerCase();
        return prefix.endsWith(' in') ? match : inner;
      },
    );
  }
  while (hasWrappingParentheses(normalized)) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function isCharacterColumnType(columnType: string): boolean {
  return /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/i.test(
    columnType,
  );
}

function expectedColumnsWithCharacterSemantics(
  table: string,
  structured: boolean,
  hybrid: boolean,
  grounding: boolean,
  storage: boolean,
  authoringBody: boolean,
): string {
  const phaseExpected =
    storage && STORAGE_EXPECTED_COLUMNS[table]
      ? STORAGE_EXPECTED_COLUMNS[table]
      : !structured
        ? (PRE_STRUCTURED_COLUMNS[table] ?? EXPECTED_COLUMNS[table])
        : hybrid
          ? EXPECTED_COLUMNS[table]
          : (PRE_HYBRID_COLUMNS[table] ?? EXPECTED_COLUMNS[table]);
  const groundingExpected = grounding
    ? phaseExpected
    : (PRE_GROUNDING_COLUMNS[table] ?? phaseExpected);
  return (authoringBody
    ? groundingExpected
    : (PRE_AUTHORING_BODY_COLUMNS[table] ?? groundingExpected)
  )
    .split(';')
    .map((signature) => {
      const [, columnType] = signature.split('|');
      return isCharacterColumnType(columnType)
        ? `${signature}|${CANONICAL_CHARACTER_SET}|${CANONICAL_TABLE_COLLATION}`
        : `${signature}|∅|∅`;
    })
    .join(';');
}

function expectedIndexesWithPhysicalSemantics(
  table: string,
  structured: boolean,
  hybrid: boolean,
  grounding: boolean,
  storage: boolean,
): string {
  const phaseExpected =
    storage && STORAGE_EXPECTED_INDEXES[table]
      ? STORAGE_EXPECTED_INDEXES[table]
      : !structured
        ? (PRE_STRUCTURED_INDEXES[table] ?? EXPECTED_INDEXES[table])
        : hybrid
          ? EXPECTED_INDEXES[table]
          : (PRE_HYBRID_INDEXES[table] ?? EXPECTED_INDEXES[table]);
  return (
    grounding ? phaseExpected : (PRE_GROUNDING_INDEXES[table] ?? phaseExpected)
  )
    .split(';')
    .map((signature) => {
      const [, , indexType] = signature.split('|');
      const sortDirection = indexType === 'FULLTEXT' ? '∅' : 'A';
      return `${signature}|∅|∅|${sortDirection}|YES`;
    })
    .join(';');
}

function expectedForeignKeysWithUpdateSemantics(
  table: string,
  structured: boolean,
  grounding: boolean,
  storage: boolean,
): string {
  if (storage && STORAGE_EXPECTED_PHYSICAL_FOREIGN_KEYS[table]) {
    return STORAGE_EXPECTED_PHYSICAL_FOREIGN_KEYS[table];
  }
  const phaseExpected = structured
    ? EXPECTED_FOREIGN_KEYS[table]
    : (PRE_STRUCTURED_FOREIGN_KEYS[table] ?? EXPECTED_FOREIGN_KEYS[table]);
  const expected = grounding
    ? phaseExpected
    : (PRE_GROUNDING_FOREIGN_KEYS[table] ?? phaseExpected);
  if (!expected) return '';
  return expected
    .split(';')
    .map((signature) => {
      const [
        constraintName,
        columnName,
        referencedTable,
        referencedColumn,
        deleteRule,
      ] = signature.split('|');
      return [
        constraintName,
        1,
        1,
        columnName,
        referencedTable,
        referencedColumn,
        deleteRule,
        'NO ACTION',
      ].join('|');
    })
    .join(';');
}

export async function findApplicationSchemaContractViolations(
  queryRunner: QueryRunner,
): Promise<string[]> {
  const storage = await queryRunner.hasTable('storage_control');
  const authoringBody = await queryRunner.hasTable('authoring_proposals');
  const placeholders = CANONICAL_TABLES.map(() => '?').join(', ');
  const [tableRows, columnRows, indexRows, foreignKeyRows, checkRows] =
    await Promise.all([
      queryRunner.query(
        `SELECT t.TABLE_NAME AS tableName,
              t.TABLE_TYPE AS tableType,
              t.ENGINE AS engine,
              t.TABLE_COLLATION AS tableCollation,
              cca.CHARACTER_SET_NAME AS characterSetName
         FROM information_schema.TABLES t
         LEFT JOIN information_schema.COLLATION_CHARACTER_SET_APPLICABILITY cca
           ON cca.COLLATION_NAME = t.TABLE_COLLATION
        WHERE t.TABLE_SCHEMA = DATABASE()
          AND t.TABLE_NAME IN (${placeholders})
        ORDER BY t.TABLE_NAME`,
        [...CANONICAL_TABLES],
      ) as Promise<unknown>,
      queryRunner.query(
        `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
              COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
              GENERATION_EXPRESSION AS generationExpression,
              CHARACTER_SET_NAME AS characterSetName,
              COLLATION_NAME AS collationName
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN (${placeholders})
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [...CANONICAL_TABLES],
      ) as Promise<unknown>,
      queryRunner.query(
        `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
              NON_UNIQUE AS nonUnique, INDEX_TYPE AS indexType,
              SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName,
              EXPRESSION AS expression, SUB_PART AS subPart,
              COLLATION AS collation, IS_VISIBLE AS isVisible
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN (${placeholders})
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        [...CANONICAL_TABLES],
      ) as Promise<unknown>,
      queryRunner.query(
        `SELECT kcu.TABLE_NAME AS tableName,
              kcu.CONSTRAINT_NAME AS constraintName,
              kcu.ORDINAL_POSITION AS sequenceNumber,
              kcu.POSITION_IN_UNIQUE_CONSTRAINT AS referencedSequenceNumber,
              kcu.COLUMN_NAME AS columnName,
              kcu.REFERENCED_TABLE_NAME AS referencedTableName,
              kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,
              rc.DELETE_RULE AS deleteRule,
              rc.UPDATE_RULE AS updateRule
         FROM information_schema.KEY_COLUMN_USAGE kcu
         JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        WHERE kcu.TABLE_SCHEMA = DATABASE()
          AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
          AND kcu.TABLE_NAME IN (${placeholders})
        ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
        [...CANONICAL_TABLES],
      ) as Promise<unknown>,
      queryRunner.query(
        `SELECT tc.TABLE_NAME AS tableName,
                tc.CONSTRAINT_NAME AS constraintName,
                tc.ENFORCED AS enforced,
                cc.CHECK_CLAUSE AS checkClause
           FROM information_schema.TABLE_CONSTRAINTS tc
           JOIN information_schema.CHECK_CONSTRAINTS cc
             ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
            AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
          WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
            AND tc.CONSTRAINT_TYPE = 'CHECK'
            AND tc.TABLE_NAME IN (${placeholders})
          ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME`,
        [...CANONICAL_TABLES],
      ) as Promise<unknown>,
    ]);

  if (
    !Array.isArray(tableRows) ||
    !Array.isArray(columnRows) ||
    !Array.isArray(indexRows) ||
    !Array.isArray(foreignKeyRows) ||
    !Array.isArray(checkRows)
  ) {
    return ['information_schema did not return row arrays'];
  }

  const violations: string[] = [];
  const structured = (columnRows as ColumnRow[]).some(
    (row) =>
      row.tableName === 'documents' && row.columnName === 'ingestion_key',
  );
  const hybrid = (columnRows as ColumnRow[]).some(
    (row) => row.tableName === 'chunks' && row.columnName === 'search_text',
  );
  const grounding = (columnRows as ColumnRow[]).some(
    (row) => row.tableName === 'citation_maps' && row.columnName === 'claim_id',
  );
  for (const table of CANONICAL_TABLES) {
    if (
      !grounding &&
      GROUNDING_TABLES.includes(table as (typeof GROUNDING_TABLES)[number])
    ) {
      continue;
    }
    const tableDefinition = (tableRows as TableRow[]).find(
      (row) => row.tableName === table,
    );
    if (
      tableDefinition?.tableType !== CANONICAL_TABLE_TYPE ||
      tableDefinition.engine !== CANONICAL_STORAGE_ENGINE ||
      tableDefinition.tableCollation !== CANONICAL_TABLE_COLLATION ||
      tableDefinition.characterSetName !== CANONICAL_CHARACTER_SET
    ) {
      violations.push(`${table}: table`);
    }

    const columns = (columnRows as ColumnRow[])
      .filter((row) => row.tableName === table)
      .map((row) =>
        [
          row.columnName,
          row.columnType,
          row.nullable,
          row.defaultValue === null ? '∅' : String(row.defaultValue),
          row.extra,
          row.generationExpression,
          normalizeNullableInformationSchemaValue(row.characterSetName),
          normalizeNullableInformationSchemaValue(row.collationName),
        ].join('|'),
      )
      .join(';');
    if (
      columns !==
      expectedColumnsWithCharacterSemantics(
        table,
        structured,
        hybrid,
        grounding,
        storage,
        authoringBody,
      )
    ) {
      violations.push(`${table}: columns`);
    }

    const indexes = (indexRows as IndexRow[])
      .filter((row) => row.tableName === table)
      .map((row) =>
        [
          row.indexName,
          Number(row.nonUnique),
          row.indexType,
          Number(row.sequenceNumber),
          normalizeNullableInformationSchemaValue(row.columnName),
          normalizeNullableInformationSchemaValue(row.expression),
          normalizeNullableInformationSchemaValue(row.subPart),
          normalizeNullableInformationSchemaValue(row.collation),
          row.isVisible,
        ].join('|'),
      )
      .join(';');
    if (
      indexes !==
      expectedIndexesWithPhysicalSemantics(
        table,
        structured,
        hybrid,
        grounding,
        storage,
      )
    ) {
      violations.push(`${table}: indexes`);
    }

    const foreignKeys = (foreignKeyRows as ForeignKeyRow[])
      .filter((row) => row.tableName === table)
      .map((row) =>
        [
          row.constraintName,
          Number(row.sequenceNumber),
          normalizeNullableInformationSchemaValue(row.referencedSequenceNumber),
          row.columnName,
          row.referencedTableName,
          row.referencedColumnName,
          row.deleteRule,
          row.updateRule,
        ].join('|'),
      )
      .join(';');
    if (
      foreignKeys !==
      expectedForeignKeysWithUpdateSemantics(
        table,
        structured,
        grounding,
        storage,
      )
    ) {
      violations.push(`${table}: foreign keys`);
    }

    const checks = (checkRows as CheckConstraintRow[])
      .filter((row) => row.tableName === table)
      .map((row) =>
        [
          row.constraintName,
          row.enforced,
          normalizeCheckClause(row.checkClause),
        ].join('|'),
      )
      .join(';');
    const expectedChecks =
      storage && STORAGE_EXPECTED_CHECKS[table]
        ? normalizeExpectedCheckSignature(STORAGE_EXPECTED_CHECKS[table])
        : EXPECTED_CHECKS[table];
    if (checks !== expectedChecks) {
      violations.push(`${table}: checks`);
    }
  }
  if (storage) {
    violations.push(
      ...(await findStorageSchemaContractViolations(queryRunner)),
    );
  }
  return violations;
}

function normalizeExpectedCheckSignature(signature: string): string {
  const [name, enforced, ...clauseParts] = signature.split('|');
  return [
    name,
    enforced,
    normalizeCheckClause(clauseParts.join('|')),
  ].join('|');
}

export function isPreservedAuthenticationSchemaViolation(
  violation: string,
): boolean {
  return AUTH_TABLES.some((table) => violation.startsWith(`${table}:`));
}

export function isAllowlistedDatabaseOnlySchemaQuery(query: string): boolean {
  if (
    DATABASE_ONLY_KEY_QUERY_ALLOWLIST.some(
      (allowlisted) => allowlisted.query === query,
    )
  ) {
    return true;
  }

  const droppedColumn = query.match(
    /^ALTER TABLE `([^`]+)` DROP COLUMN `([^`]+)`$/,
  );
  if (droppedColumn) {
    return DATABASE_ONLY_COLUMN_ALLOWLIST.some(
      ({ table, column }) =>
        table === droppedColumn[1] && column === droppedColumn[2],
    );
  }

  const changedUuidId = query.match(
    /^ALTER TABLE `([^`]+)` CHANGE `id` `id` varchar\(36\) NOT NULL$/,
  );
  return Boolean(
    changedUuidId &&
    SERVER_UUID_DEFAULT_ALLOWLIST.includes(
      changedUuidId[1] as (typeof SERVER_UUID_DEFAULT_ALLOWLIST)[number],
    ),
  );
}
