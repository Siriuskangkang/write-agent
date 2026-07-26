import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1710700000000 implements MigrationInterface {
  name = 'InitSchema1710700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        nickname VARCHAR(100) NULL,
        avatar_url VARCHAR(500) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        user_id VARCHAR(36) NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_refresh_tokens_user_id (user_id),
        CONSTRAINT refresh_tokens_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        user_id VARCHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) NULL,
        target_audience TEXT NULL,
        target_chapters INT NOT NULL DEFAULT 10,
        style VARCHAR(50) NOT NULL DEFAULT '教材',
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        description TEXT NULL,
        active_style_template_id VARCHAR(36) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_projects_user_id (user_id),
        CONSTRAINT projects_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS project_states (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        current_directory_version_id VARCHAR(36) NULL,
        completed_chapters JSON NOT NULL,
        in_progress_chapter VARCHAR(255) NULL,
        in_progress_section VARCHAR(255) NULL,
        pending_items JSON NOT NULL,
        material_gaps JSON NOT NULL,
        user_notes TEXT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_project_states_project_id (project_id),
        CONSTRAINT project_states_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS source_files (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        file_name VARCHAR(500) NOT NULL,
        file_type VARCHAR(20) NOT NULL,
        file_size BIGINT NULL,
        file_path VARCHAR(1000) NOT NULL,
        parse_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        error_message TEXT NULL,
        uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_source_files_project_id (project_id),
        KEY idx_source_files_parse_status (parse_status),
        KEY idx_source_files_uploaded_at (uploaded_at),
        CONSTRAINT source_files_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        file_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        title VARCHAR(500) NULL,
        content_text TEXT NULL,
        page_count INT NULL,
        sections JSON NULL,
        parsed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_documents_project_id (project_id),
        KEY idx_documents_file_id (file_id),
        CONSTRAINT documents_file_id_fkey
          FOREIGN KEY (file_id) REFERENCES source_files(id) ON DELETE CASCADE,
        CONSTRAINT documents_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        file_id VARCHAR(36) NOT NULL,
        document_id VARCHAR(36) NOT NULL,
        chunk_index INT NOT NULL,
        content TEXT NOT NULL,
        section_title VARCHAR(500) NULL,
        page_number INT NULL,
        keywords JSON NULL,
        search_terms JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_chunks_project_id (project_id),
        KEY idx_chunks_file_id (file_id),
        FULLTEXT KEY idx_chunks_content_fulltext (content),
        CONSTRAINT chunks_document_id_fkey
          FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        CONSTRAINT chunks_file_id_fkey
          FOREIGN KEY (file_id) REFERENCES source_files(id) ON DELETE CASCADE,
        CONSTRAINT chunks_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        title VARCHAR(255) NOT NULL DEFAULT '新会话',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_sessions_project_id (project_id),
        KEY idx_sessions_user_id (user_id),
        CONSTRAINT sessions_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CONSTRAINT sessions_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        session_id VARCHAR(36) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        message_type VARCHAR(30) NOT NULL DEFAULT 'chat',
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_messages_session_id (session_id),
        CONSTRAINT messages_session_id_fkey
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS directory_versions (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        version_number INT NOT NULL,
        content JSON NOT NULL,
        is_current TINYINT(1) NOT NULL DEFAULT 0,
        current_marker TINYINT
          GENERATED ALWAYS AS (
            CASE WHEN is_current = 1 THEN 1 ELSE NULL END
          ) STORED,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_directory_versions_project_id (project_id),
        UNIQUE KEY uq_directory_versions_scope_version
          (project_id, version_number),
        UNIQUE KEY uq_directory_versions_current (project_id, current_marker),
        CONSTRAINT directory_versions_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    const currentDirectoryForeignKey: unknown = await queryRunner.query(
      `SELECT 1
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'project_states'
          AND COLUMN_NAME = 'current_directory_version_id'
          AND REFERENCED_TABLE_NAME = 'directory_versions'
        LIMIT 1`,
    );
    if (
      !Array.isArray(currentDirectoryForeignKey) ||
      currentDirectoryForeignKey.length === 0
    ) {
      await queryRunner.query(`
        ALTER TABLE project_states
        ADD CONSTRAINT project_states_current_directory_version_id_fkey
        FOREIGN KEY (current_directory_version_id)
        REFERENCES directory_versions(id)
        ON DELETE SET NULL
      `);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS outline_versions (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        chapter_node_id VARCHAR(100) NOT NULL,
        section_node_id VARCHAR(100) NULL,
        chapter_index INT NOT NULL,
        chapter_title VARCHAR(500) NOT NULL,
        version_number INT NOT NULL,
        content JSON NOT NULL,
        is_current TINYINT(1) NOT NULL DEFAULT 0,
        scope_section_node_id VARCHAR(100)
          GENERATED ALWAYS AS (COALESCE(section_node_id, '')) STORED,
        current_marker TINYINT
          GENERATED ALWAYS AS (
            CASE WHEN is_current = 1 THEN 1 ELSE NULL END
          ) STORED,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_outline_versions_project_id (project_id),
        KEY idx_outline_versions_scope
          (project_id, chapter_node_id, scope_section_node_id),
        UNIQUE KEY uq_outline_versions_scope_version
          (project_id, chapter_node_id, scope_section_node_id, version_number),
        UNIQUE KEY uq_outline_versions_current
          (project_id, chapter_node_id, scope_section_node_id, current_marker),
        CONSTRAINT outline_versions_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS writing_results (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        session_id VARCHAR(36) NULL,
        chapter_node_id VARCHAR(100) NULL,
        section_node_id VARCHAR(100) NULL,
        chapter_index INT NULL,
        chapter_title VARCHAR(500) NULL,
        section_title VARCHAR(500) NULL,
        task_type VARCHAR(30) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'streaming',
        content_text TEXT NOT NULL,
        word_count INT NULL,
        style VARCHAR(50) NULL,
        version_number INT NOT NULL DEFAULT 1,
        parent_result_id VARCHAR(36) NULL,
        error_message TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_writing_results_project_id (project_id),
        KEY idx_writing_results_chapter (project_id, chapter_node_id),
        KEY idx_writing_results_session_id (session_id),
        CONSTRAINT writing_results_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CONSTRAINT writing_results_session_id_fkey
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS content_versions (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        result_id VARCHAR(36) NOT NULL,
        version_number INT NOT NULL,
        editor_source VARCHAR(20) NOT NULL DEFAULT 'ai',
        content_text TEXT NOT NULL,
        is_current TINYINT(1) NOT NULL DEFAULT 0,
        current_marker TINYINT
          GENERATED ALWAYS AS (
            CASE WHEN is_current = 1 THEN 1 ELSE NULL END
          ) STORED,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_content_versions_result_id (result_id),
        UNIQUE KEY uq_content_versions_scope_version
          (result_id, version_number),
        UNIQUE KEY uq_content_versions_current (result_id, current_marker),
        CONSTRAINT content_versions_result_id_fkey
          FOREIGN KEY (result_id) REFERENCES writing_results(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS citation_maps (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        result_id VARCHAR(36) NOT NULL,
        paragraph_key VARCHAR(200) NOT NULL,
        chunk_id VARCHAR(36) NOT NULL,
        file_id VARCHAR(36) NOT NULL,
        use_type VARCHAR(30) NOT NULL,
        evidence_text TEXT NOT NULL,
        page_number INT NULL,
        section_title VARCHAR(500) NULL,
        confidence_score FLOAT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_citation_maps_result_id (result_id),
        KEY idx_citation_maps_chunk_id (chunk_id),
        KEY idx_citation_maps_project_id (project_id),
        KEY idx_citation_maps_file_id (file_id),
        CONSTRAINT citation_maps_chunk_id_fkey
          FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
        CONSTRAINT citation_maps_file_id_fkey
          FOREIGN KEY (file_id) REFERENCES source_files(id) ON DELETE CASCADE,
        CONSTRAINT citation_maps_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CONSTRAINT citation_maps_result_id_fkey
          FOREIGN KEY (result_id) REFERENCES writing_results(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS export_jobs (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        format VARCHAR(20) NOT NULL,
        scope VARCHAR(20) NOT NULL,
        chapter_ids JSON NULL,
        include_citations TINYINT(1) NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        file_path VARCHAR(1000) NULL,
        error_message TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_export_jobs_project_id (project_id),
        CONSTRAINT export_jobs_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        user_id VARCHAR(36) NOT NULL,
        settings JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_user_settings_user_id (user_id),
        CONSTRAINT user_settings_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      for (const table of [
        'user_settings',
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
        'refresh_tokens',
        'users',
      ]) {
        await queryRunner.query(`DROP TABLE IF EXISTS \`${table}\``);
      }
    } finally {
      await queryRunner.query(`SET FOREIGN_KEY_CHECKS = 1`);
    }
  }
}
