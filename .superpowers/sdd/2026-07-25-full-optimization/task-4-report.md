# Task 4 Report — 可复现迁移基线与并发版本写入

## 结果

- 修复 MySQL 8.4 fresh migration 的重复列/错误索引，并让 fresh schema 满足当前
  TypeORM 实体所需列、版本唯一索引和外键合同。
- 新增 `1712100000000-ReconcileApplicationSchema`，支持从已执行
  `InitSchema + AddSectionNodeId` 的旧空业务 schema 前向重建。
- `users`、`refresh_tokens`、`user_settings` 不进入 reconciliation drop 集合；
  测试确认用户、密码 hash、refresh token hash 和 settings 原样保留。
- 目录、大纲、正文版本写入不再使用 `count() + 1`；真实 MySQL 同 scope 两请求均
  生成连续 `[1, 2]`，且只有版本 2 为 current。
- 计划提交信息：`fix: establish reproducible schema and versioning`。

## Runtime schema contract 决策

当前 TypeORM 实体是 runtime contract。旧 migration 中与实体冲突的
`nodes/content`、`project_id/node_id/content`、旧 writing result、export job 和
style template 结构不再作为运行时合同。

数据库额外保留两类实现列：

- auth 兼容列/表：`users.avatar_url` 和 `user_settings`；
- 版本唯一性 generated columns：目录/正文的 `current_marker`，大纲的
  `scope_section_node_id` 与 `current_marker`。

这些列用于 MySQL 唯一约束，不要求 TypeORM 在写入时提供。

## TDD RED 证据

### Fresh migration

首次在独立 `mysql:8.4` 临时容器、随机 schema 运行：

```text
npm run test:e2e -- migrations.e2e-spec.ts --runInBand
FAIL
Migration "AddSectionNodeIdToOutlineVersions1710800000000" failed
Duplicate column name 'section_node_id'
```

修复重复列后，runtime column contract 继续 RED，确认不是单点语法问题：

```text
missing runtime entity columns:
- messages.message_type
- directory_versions.content
- outline_versions.chapter_index
- outline_versions.chapter_title
- writing_results.session_id
- writing_results.task_type
- writing_results.content_text
- content_versions.result_id
- content_versions.editor_source
- content_versions.content_text
- export_jobs.scope
- export_jobs.chapter_ids
- export_jobs.include_citations
- export_jobs.completed_at
- style_templates.file_path
...
```

索引/FK contract 另一次 RED 捕获：

```text
project_states.current_directory_version_id
  -> directory_versions.id ON DELETE SET NULL
```

### 旧 schema、安全拒绝和 auth

- fixture 先只执行 `InitSchema + AddSectionNodeId`，再把关键表恢复为检查到的旧结构。
  完整升级在没有 171210 时仍缺同一批 runtime 列。
- fixture 已执行到 171208 后插入 `projects=1`；没有 171210 时
  `runMigrations()` 错误地 resolve，证明不存在业务数据安全门。
- 新测试在 171210 失败后比较全部 columns/indexes/FKs 快照，要求任一业务表非空时
  零 DDL。

### 版本并发

真实 MySQL 表上为 INSERT 增加 150ms 测试 trigger，稳定放大旧
`count() + 1` 竞态。目录、大纲、正文三个 scope 分别 RED：

```text
Duplicate entry '...-1' for key '...uq_*_scope_version'
```

目录另有回滚用例：删除 `project_states` 后保存必须失败，且
`directory_versions` 保持 0 行。

## 实现

### 历史迁移改动

- `1710700000000-InitSchema.ts`
  - 修正 fresh-install 表定义，使必需列、类型、nullability、索引和 FK 与当前实体
    使用方式一致。
  - 新增三个 version scope/version 唯一约束和唯一 current 约束。
  - 新增 project state current directory pointer FK。
- `1710800000000-AddSectionNodeIdToOutlineVersions.ts`
  - `section_node_id` 和相关索引存在时跳过，消除 fresh duplicate。
  - 使用 `information_schema` 做 MySQL 8.4 兼容的 index existence 检查。
- `1711800000000-CreateStyleTemplates.ts`
  - 改为 `CREATE TABLE IF NOT EXISTS`，补齐实体所需 `file_path` 和 status enum。
  - 删除对不存在 `is_active` 的索引；active style column/index/FK 均改为存在性检查。
- `1712000000000-FixCitationMapsCascade.ts`
  - 仅在 chunk/file FK 还不是 `ON DELETE CASCADE` 时重建，fresh 路径可重复执行。

已提交的 `171205`、`171206`、`171207`、`171208` 文件没有任何改动。

### 171210 reconciliation

1. 从 `information_schema` 找出现存业务表。
2. 在任何 `SET`、`ALTER`、`DROP` 或 `CREATE` 前逐表执行 `COUNT(*)`。
3. 收集任意非零表并抛出，例如：
   `Cannot reconcile ... business tables are not empty: projects=1`。
4. 业务表全空且 schema 已满足 current sentinels/unique indexes 时 no-op。
5. 旧空 schema 才关闭当前连接的 FK checks、按显式白名单 drop 业务表并立即恢复
   FK checks，然后复用修正后的历史 migration `up()` 链重建。
6. reconciliation 不可安全逆转，`down()` 明确拒绝。

### 事务化版本写入

- 目录和大纲在事务内 `SELECT projects ... FOR UPDATE`，正文在事务内
  `SELECT writing_results ... FOR UPDATE`。
- 锁内通过 `MAX(version_number) + 1` 分配下一版本；数据库唯一 scope/version
  约束是最终防线。
- current 旧版本取消与新版本写入在同一事务。
- 目录的新 current id 与 `project_states.current_directory_version_id` 在同一事务；
  state 不存在时抛错并回滚整个版本写入。

## 最终 fresh 验证

```text
cd backend

npm run test:e2e -- migrations.e2e-spec.ts --runInBand
Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total

npm test -- --runInBand
Test Suites: 1 skipped, 24 passed, 24 of 25 total
Tests:       22 skipped, 184 passed, 206 total

npm run build
exit 0

npm run lint:check
exit 0; 37 existing warnings, 0 errors

git diff --check
exit 0
```

8 个 migration e2e 覆盖：

- fresh 全迁移；
- fresh columns/indexes/FKs contract；
- 旧 `Init + AddSection` 升级和 auth 数据保留；
- 任一业务表非空的 pre-DDL 拒绝和 schema 零变化；
- 目录、大纲、正文三类同 scope 并发；
- project state 更新失败时目录版本事务回滚。

测试未连接或修改 `textweaver`。migration e2e 自行启动独立 MySQL 8.4 临时容器，
每个场景使用随机 schema；最终检查无 `write-agent-migration-e2e-*` 容器残留。

## 已知输出

- 全量 Jest 会打印既有 `--localstorage-file` warning，以及负向测试预期的 Nest error
  log；退出码为 0。
- 非空 reconciliation 用例会打印预期 migration failure log；断言确认错误消息和
  DDL 快照。
- lint 的 37 条 warning 与此前任务报告的基线一致；本任务文件无 lint error。

## Independent Review Round 1 修复

### RED 证据

1. 文档入口真实执行失败：

   ```text
   npm run migration:run
   Error: Cannot find module './1710700000000-InitSchema.js'
   Require stack:
   - migrations/1712100000000-ReconcileApplicationSchema.ts
   ```

   新增用例不经过 Jest mapper，直接对子进程设置随机数据库连接后执行仓库文档命令。

2. 在完整 schema 上人为模拟部分 DDL：

   - `file_move_intents.recover_after` 改回 `DATETIME(6)`；
   - 删除 `citation_maps.chunk_id` FK；
   - 把目录 scope/version 同名唯一索引改成非唯一且反序。

   旧 sentinel 检查错误 no-op，快照仍保留上述三类 drift。

3. project delete 先删子表、目录写入先锁 parent 时，真实 MySQL trigger 放大交错，
   writer 稳定收到：

   ```text
   Deadlock found when trying to get lock; try restarting transaction
   ```

4. 历史 down 的真实 MySQL 8.4 RED：

   - `171080` 因 `DROP INDEX IF EXISTS ... ON ...` 触发 `ER_PARSE_ERROR`；
   - `171180` 错误删除 Init 已拥有的 style table/project pointer 并成功返回。

5. fresh schema 的 TypeORM metadata diff 初始产生 137 条语句，包含 datetime(6)
   drift、`style_templates.project_id varchar(255)` drift、JSON/text default drift，
   以及 migration-managed key 和数据库专用列的删除建议。

### 修复

- 171210 sibling migration import 改为 ts-node CommonJS 入口实际可加载的
  extensionless specifier；fresh 和 old-empty 都通过真实 `npm run migration:run`。
- `migrations/support/application-schema-contract.ts` 成为单一 MySQL 8.4 contract：
  - 所有 17 张业务表；
  - 每列的 `COLUMN_TYPE`、nullability、default、extra、generated expression；
  - 全部索引的唯一性、类型、列顺序；
  - 全部 FK 的列、目标和 delete rule。
- 171210 仅在完整 contract 零违规时 no-op；部分 DDL 或任意属性 drift 时，在确认所有
  业务表为空后重建，最后再次强校验 contract。任何 DDL 中断后的重试都会重新收敛，
  不再依赖少量 sentinel。
- DB-only allowlist 已命名并附理由：
  - auth compatibility：`users.avatar_url`；
  - migration compatibility：`projects.active_style_template_id`；
  - current/scope 唯一性 generated columns；
  - 实体 id 的数据库端 UUID fallback；
  - 已由 exact contract 独立验证的 migration-managed indexes/FKs。
  普通实体列不允许跳过。
- entity metadata 显式统一 datetime type/precision/default/onUpdate；
  `StyleTemplate.projectId` 改为 `varchar(36)`。WritingResult text 和 ProjectState JSON
  不再使用 MySQL/TypeORM 永久产生 diff 的表达式 default；ProjectService 创建状态时
  显式写入三个空数组。
- ProjectService 删除事务第一条语句锁定 owner-scoped project parent；目录/大纲
  version writer 在 parent lock 返回空时抛 `项目不存在`。writer-vs-delete 现在删除
  成功、writer 得到可解释业务错误，不泄漏死锁。
- 171080/171180 的 `down()` 显式拒绝不安全回滚；真实 `undoLastMigration()` 验证
  错误清楚且 DDL 快照完全不变。
- 171205–171208 相对 `8d42218` byte-for-byte 无变化。

### Round 1 最终验证

```text
npm run test:e2e -- migrations.e2e-spec.ts --runInBand
Test Suites: 1 passed, 1 total
Tests:       15 passed, 15 total

npm test -- --runInBand
Test Suites: 1 skipped, 24 passed, 24 of 25 total
Tests:       22 skipped, 184 passed, 206 total

npm run build
exit 0

npm run lint:check
exit 0; 37 existing warnings, 0 errors

git diff --check
exit 0
```

测试只使用自行创建并清理的 MySQL 8.4 容器和随机 schema；fresh、old-empty、
partial-retry、non-empty zero-DDL、historical down 和版本/删除并发均未连接
`textweaver`。最终无 `write-agent-migration-e2e-*` 或 Task 4 临时容器残留。

## Independent Review Round 2 修复

### RED 证据

在真实 MySQL 8.4 fresh schema 上增加三类结构 mutation，生产代码修改前
`migrations.e2e-spec.ts` 为 15/18：

1. `file_cleanup_records` 改为 MyISAM、`file_move_intents` 改为
   `utf8mb4_bin` 后，canonical contract 错误返回 `[]`。
2. 删除 `uq_users_email`，以及
   `refresh_tokens_user_id_fkey` / `idx_refresh_tokens_user_id` 后，
   canonical contract 错误返回 `[]`。
3. 任意 `users` unique index、任意 `refresh_tokens` FK 和未知表 index query
   均被旧全局正则错误 allowlist。

对应失败均是行为断言，不是编译或 fixture 错误。

### 修复

- canonical contract 现在对 `users`、`refresh_tokens`、`user_settings` 和全部
  17 张业务表逐表校验：
  - `TABLE_TYPE=BASE TABLE`
  - `ENGINE=InnoDB`
  - `TABLE_COLLATION=utf8mb4_0900_ai_ci`
  - charset `utf8mb4`
  - 完整列签名、索引名/唯一性/顺序，以及 FK 名/列/目标/delete rule
- 171210 仍先对全部现存业务表逐表 `COUNT(*)`；只要任一业务表非空，仍在任何
  DDL 前拒绝。snapshot 现包含 table engine/collation，因此零 DDL 断言也覆盖
  table-level 属性。
- auth contract 有任何 drift 时，171210 明确拒绝并保持 auth/业务 schema
  不变，不再错误 no-op，也不会通过 drop/recreate 处理保留表。
- 空业务表存在 engine/collation drift 时，reconciliation 重建后逐表收敛到
  `InnoDB + utf8mb4_0900_ai_ci`；测试确认现存 user/password hash 原样保留。
- 删除全局 index/FK 正则 allowlist。新的 key allowlist 每条都有
  `table + exact name + exact full query + reason`：
  - application migration-managed key 仅在 canonical contract 已精确验证后放行；
  - TypeORM 生成但与 canonical key 语义重复的 query 逐条列出；
  - auth 仅保留 `refresh_tokens_user_id_fkey` 的单条精确 DROP query，原因是实体
    有意只暴露标量 `user_id`，而该 FK 仍由 auth contract 强制验证。
- `User.email` 与 `RefreshToken.user_id` 的 TypeORM metadata 使用 canonical
  index 名，避免 auth unique/index 被宽泛放行。删除任意 auth unique/FK/index
  后，contract 都产生明确 violation，171210 安全失败。
- `171205`–`171208` 相对 `8d42218` 仍 byte-for-byte 无变化。

### Round 2 最终验证

```text
npm run test:e2e -- migrations.e2e-spec.ts --runInBand
Test Suites: 1 passed, 1 total
Tests:       18 passed, 18 total

npm test -- --runInBand
Test Suites: 1 skipped, 24 passed, 24 of 25 total
Tests:       22 skipped, 184 passed, 206 total

npm run build
exit 0

npm run lint:check
exit 0; 37 existing warnings, 0 errors

git diff --check
exit 0
```

新增 mutation 用例确认：

- MyISAM 与错误 collation 均被检出并安全收敛；
- auth unique/FK/index drift 被检出，拒绝过程 schema/auth 数据零变化；
- 任意 auth/未知表 key query 不再被全局规则放行；
- 完整 fresh schema 的 TypeORM drift 仅包含逐条有理由的精确 allowlist。

全部测试仅使用自动创建并清理的 MySQL 8.4 容器与随机 schema，未连接
`textweaver`；最终无 `write-agent-migration-e2e-*` 容器残留。

## Independent Review Round 3 修复

### RED 证据

在真实 MySQL 8.4 fresh schema 上增加三项 fail-closed mutation。生产代码修改前，
三个用例均稳定失败且 contract 错误返回空数组：

1. `users.email` 单列改为 `utf8mb4_bin`，表默认 collation 保持不变；
2. `uq_users_email` 改成唯一前缀索引 `email(10)`；
3. `refresh_tokens_user_id_fkey` 保持同名、同列和 `ON DELETE CASCADE`，
   仅改成 `ON UPDATE CASCADE`。

第三项最初把 drop/add 合并在同一条 `ALTER TABLE`，MySQL 8.4 因同名 FK 报错。
测试随后拆成两条语句并重新执行，确认失败来自 contract 缺少 `UPDATE_RULE`，不是
fixture 语法。

```text
Test Suites: 1 failed, 1 total
Tests:       3 failed, 18 skipped, 21 total

Expected: users: columns / users: indexes /
          refresh_tokens: foreign keys
Received: []
```

### 修复

canonical MySQL 8.4 contract 现在对 preserved auth 和全部 application table
覆盖以下实际 `information_schema` 字段：

- 列：原有 type/null/default/extra/generated expression 之外，增加每个字符列的
  `CHARACTER_SET_NAME` 和 `COLLATION_NAME`；
- 索引：`SEQ_IN_INDEX`、`COLUMN_NAME`、`EXPRESSION`、`SUB_PART`、
  `COLLATION`、`NON_UNIQUE`、`INDEX_TYPE` 和 `IS_VISIBLE`；
- 外键：本地列顺序、引用唯一键位置、引用列、`DELETE_RULE` 和
  `UPDATE_RULE`。

字符列的期望 charset/collation 由 canonical column type 推导，非字符列显式要求
information schema 返回 NULL。索引列、表达式、prefix、排序方向等 nullable
字段统一归一化为 `∅`；BTREE 索引固定升序可见，FULLTEXT 的非排序语义固定为
NULL。所有 canonical FK 当前均明确要求 `ON UPDATE NO ACTION`。

三个 mutation 现在都会被 auth contract 检出；`171210` 在应用表重建前拒绝，
mutation 后的完整 DDL 快照保持不变。

### Round 3 最终验证

```text
npm run test:e2e -- migrations.e2e-spec.ts --runInBand
Test Suites: 1 passed, 1 total
Tests:       21 passed, 21 total

npm test -- --runInBand
Test Suites: 1 skipped, 24 passed, 24 of 25 total
Tests:       22 skipped, 184 passed, 206 total

npm run build
exit 0

npm run lint:check
exit 0; 37 existing warnings, 0 errors

git diff --check
exit 0
```

`171205`–`171208` 相对 `8d42218` 仍 byte-for-byte 无变化；测试结束后无
`write-agent-migration-e2e-*` 容器残留。

## Independent Review Round 4 修复

### RED 证据

在真实 MySQL 8.4 fresh schema 上新增两项 CHECK mutation。生产代码修改前，
迁移 E2E 为 21/23，且两个失败都来自 canonical contract 错误返回空数组：

1. `directory_versions` 增加
   `chk_no_current CHECK (is_current = 0)`；
2. 已有保留用户数据的 `users` 增加
   `chk_users_email_present CHECK (email <> '')`。

```text
Expected: directory_versions: checks / users: checks
Received: []

Test Suites: 1 failed, 1 total
Tests:       2 failed, 21 passed, 23 total
```

### 修复

- canonical contract 对 3 张认证表与 17 张业务表逐表显式列出完整 CHECK 集合；
  当前 schema 的合法集合全部为空，未来若引入 CHECK 必须明确登记。
- 从 `information_schema.TABLE_CONSTRAINTS` 与 `CHECK_CONSTRAINTS` 同时读取并比较：
  - constraint name；
  - `ENFORCED` 状态；
  - `CHECK_CLAUSE`。
- CHECK 表达式归一化只移除覆盖整个表达式的冗余外括号，并只折叠 SQL
  字符串、quoted identifier 之外的空白；不会改写字符串内容。
- 空业务库存在额外业务 CHECK 时，171210 按既有安全路径重建业务表；测试随后实际
  写入 `is_current=1` 的首个目录版本成功。
- auth 表存在额外 CHECK 且含保留用户数据时，171210 在任何 DDL 前 fail closed；
  包含 CHECK 的完整 schema snapshot 和账号 hash 都保持不变。
- schema snapshot 也纳入 CHECK 名称、enforcement 与 clause，零 DDL 断言覆盖新增
  约束类型。

### Round 4 最终验证

```text
npm run test:e2e -- migrations.e2e-spec.ts --runInBand
Test Suites: 1 passed, 1 total
Tests:       23 passed, 23 total

npm test -- --runInBand
Test Suites: 1 skipped, 24 passed, 24 of 25 total
Tests:       22 skipped, 184 passed, 206 total

npm run build
exit 0

npm run lint:check
exit 0; 37 existing warnings, 0 errors

git diff --check
exit 0
```

`171205`–`171208` 相对 `8d42218` 仍 byte-for-byte 无变化；测试只使用自动创建和
清理的 MySQL 8.4 容器及随机 schema，未连接 `textweaver`，最终无迁移测试容器残留。
