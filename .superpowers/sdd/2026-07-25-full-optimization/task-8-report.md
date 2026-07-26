# Task 8 Report — 结构化解析与版本化摄取审查修复

## 结果

- 解析 worker 只打开一次源文件，通过同一文件描述符在读取前后校验
  size、mtime、ctime、inode，并对读取到的同一份 bytes 计算 SHA-256。上传
  checksum 或大小不一致、读取期间原地变更、超出预算时均在 parser/ingestion
  前失败。
- `source_files` 与 `file_upload_outbox` 新增持久 `parse_generation`。
  reparse 在 MySQL 事务及悲观锁内同时递增 generation 并写 durable outbox；
  worker 的 PARSING、DONE、FAILED 和 ingestion activation 全部按当前
  generation fencing，旧 attempt 不能覆盖新成功。
- `171270` 会比较 generated column、index 和 foreign key 的完整物理定义；
  同名但表达式、唯一性、列序、引用或级联动作错误时按依赖顺序重建，不删除
  document/chunk 业务行。
- Markdown/DOCX 标题路径改为只含真实祖先的紧凑数组。DOCX/PPTX 解析基于
  namespace local name；DOCX 读取 styles 与 numbering，PPTX 按
  `presentation.xml` relationships 确定顺序，并只把 title/ctrTitle
  placeholder 作为标题。无法确认顺序、标题或正文时显式 degraded/failed。
- 五类 parser 统一 byte、page、slide、block、character、token、time 预算及
  AbortSignal。PDF 的 loading task 和 document 在正常、异常和超时路径均由
  `finally` 清理。
- finalized AST 对 version、location、block type/ID/text、紧凑 heading path、
  UTF-16 offsets/order、page range 和 metadata 做运行时校验。
- 旧 sparse retrieval 在 Task 9 切换 Hybrid RAG 前，也会匹配
  `section_title` 与 `heading_path`。

## RED 证据

- parser RED 复现：
  - H2 起始标题输出 `[undefined, "第一节"]`；
  - 替代 namespace DOCX 输出 0 blocks；
  - relationship 重排 PPTX 标题为空且顺序错误；
  - MD/TXT/OOXML/PDF 不执行统一预算；
  - 非法 AST heading path 未被拒绝。
- worker/reparse RED 复现：
  - 缺少 checksum snapshot 边界；
  - reparse 直接更新状态并投递 Bull，不存在 generation；
  - 旧失败无条件写 FAILED。
- retrieval RED 证明查询只匹配 `c.content`。
- 真实 MySQL partial schema 与并发用例在实现前缺少 exact reconciliation 和
  attempt fencing。

## 验证

- Task 8 定向单元测试：7 suites，44/44 passed。
- 全量后端单元测试：46 suites passed，408 passed，35 skipped。
- 真实 MySQL structured ingestion：4/4 passed，包括：
  - 重复/并发消费和 active version 切换；
  - legacy 行保留及重试；
  - 同名错误 generated/index/FK 完整收敛；
  - 旧 A 晚失败、新 B 成功后最终保持 generation 2 / DONE。
- 全量真实 MySQL migration：34/34 passed；历史空库升级用例使用单用例
  30 秒显式 timeout，未放宽全局门禁。
- 真实 PDF fixture：passed。
- Backend build：passed。
- `lint:check`：0 errors，31 个既有 warnings。
- `git diff --check`：passed。
- 临时 MySQL 容器和随机 schema 已清理；未连接本地 `textweaver`，未推送或部署。

## Round 2 — 独立复审问题闭环

第二轮根据独立审查的 4 个 Important finding 继续执行
RED → GREEN → REFACTOR：

- **同 generation attempt fencing**
  - 每次成功 claim 生成独立 UUID token，并在单条原子更新中写入
    `PARSING + parse_attempt_token + parse_lease_expires_at`。
  - 只有 `PENDING`、`FAILED` 或租约已过期的 `PARSING` 可 claim；
    `DONE` 重投直接幂等返回。
  - ingestion 事务锁定 `source_files`，同时校验 generation、status、token
    以及数据库时钟下的租约；DONE/FAILED 更新均包含 token fence。
  - 新增前向迁移 `1712800000000-AddParseAttemptLeases`，兼容已经记录旧
    `171270` 的数据库，并保留既有 source row。
- **OOXML namespace 与关系安全**
  - XML 解析改为保序 namespace-aware tree，Word、Presentation、Drawing、
    Office relationship 和 Package relationship 均校验 Transitional/Strict
    精确 URI；支持 XML 规范内建的 `xml` prefix 并拒绝错误重绑定，同时拒绝
    其他未声明 prefix、错误 root namespace、DOCTYPE/ENTITY。
  - PPTX 仅接受精确 slide relationship type；`TargetMode=External`、
    未知 TargetMode、重复关系、缺失关系和非法路径均拒绝或 degraded。
  - relationship target 禁止绝对路径、scheme、反斜杠、NUL、query、
    fragment、编码逃逸及 `.`/`..`，并限制为 `ppt/slides/*.xml`。
- **增量 parser budget**
  - `ParserBudgetGuard` 新增增量 block/text reservation；先计费再保留文本，
    并禁止 parser 绕过增量 guard 直接塞入 block。
  - Markdown 使用行 cursor，TXT 使用 paragraph/line generator，PDF 按 text
    item，DOCX/PPTX 按 namespace traversal 与 text chunk 持续检查
    block/char/token/time/abort 预算。
- **有界 verified snapshot**
  - 同一文件描述符只分配“初始文件大小 + 1 字节”的独立 Buffer，分段读取且
    每次读取不超过剩余容量；既能探测并发增长，也不会让几字节文件长期持有
    默认约 50 MiB 的 backing buffer。
  - 正常有界读取后继续校验 size、mtime、ctime、inode 和 checksum，避免
    路径替换及读取期间原地变更。

### Round 2 验证

- 全量后端单元测试：46 suites passed、2 skipped；416 passed、35 skipped。
- 真实 MySQL structured ingestion：5/5 passed，包括同 generation 未过期
  duplicate 拒绝、租约过期后新 token 接管、旧 attempt 迟到失败不覆盖
  DONE、DONE 重投不再调用 parser。
- 全量真实 MySQL migration：35/35 passed；前向租约迁移保留 FAILED source
  row 并补齐精确 `CHAR(36)` / `DATETIME(6)` 列。
- 真实 PDF fixture：passed。
- Backend build：passed。
- `lint:check`：0 errors，31 个既有 warnings。
- `git diff --check`：passed。

## Round 3 — OOXML 语义与可抢占预算闭环

第三轮针对独立复审剩余的 2 个 Important finding 继续执行
RED → GREEN → REFACTOR：

- **relationship target 统一安全校验**
  - target 在 percent-decode 前后都拒绝 query、fragment、NUL/控制字符、
    反斜杠、绝对路径、URI scheme 与 `.` / `..` 路径段。
  - decode 后仍含 `%` 时按双重编码拒绝；只接受规范的
    `slides/<part>.xml`，并要求规范化后的 `ppt/slides/...` 与 ZIP
    central directory entry 大小写完全一致。
  - `TargetMode=External` 始终拒绝；PPTX 采用两阶段解析，只有通过关系校验的
    精确 slide part 才进入第二阶段 XML 解析，shadow part 不进入语义链路。
- **`xml:space="preserve"` 语义**
  - namespace tree 保留 XML 规范 namespace attribute，并按继承与
    `xml:space="default"` 重置规则识别 preserve。
  - DOCX/PPTX block 将该语义写入 AST metadata；显式 preserve 的 block 仅统一
    换行符，不再删除首尾空白。未声明 preserve 的格式继续执行原有边界 normalize。
  - DOCX/PPTX parser version 升至 `*-ast-4`，确保摄取 identity 不复用旧语义。
- **OOXML 可抢占执行边界**
  - ZIP entry 解压、XML 校验与完整 namespace tree 构建迁入独立
    `worker_threads`；主线程按整个 parser 的剩余 deadline 和 AbortSignal
    终止 worker，并等待 `terminate()` 完成后才 settle。
  - worker 内再次校验最大 entry 数、单 entry/总解压大小、XML node/depth、
    slide、block、char 与 token 配额；Nest build 会把 worker runtime
    复制到 `dist`。
  - DOCX 一次解析 document/styles/numbering；PPTX 第一阶段解析
    presentation/relationships，第二阶段只解析已验证 slide。两阶段共同受主线程
    剩余总时限约束。

### Round 3 验证

- Round 3 parser 回归：24/24 passed；新增 percent-encoded query/fragment/NUL/
  backslash/double-encoding fixture、`xml:space` fixture、12 万段 DOCX timeout/
  abort fixture。
- 10 ms 重型 DOCX 测试在 250 ms 门限内中止，连续运行 3 次均通过；timeout 与
  Abort 返回前 active worker count 均为 0。
- Task 8 定向单元测试：6 suites，42/42 passed。
- 全量后端单元测试：46 suites passed、2 skipped；420 passed、35 skipped。
- 真实 PDF fixture：passed。
- Backend build：passed；编译产物内 worker runtime 实际 DOCX smoke test passed。
- `lint:check`：0 errors，31 个既有 warnings。
- `node --check` worker runtime 与 `git diff --check`：passed。
