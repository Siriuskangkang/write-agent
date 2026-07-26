# 贡献指南

感谢参与灵思睿著开发。提交应保持范围明确、可验证，并与当前文档一致。

## 开始开发

1. 阅读 [README](./README.md)、[系统架构](./docs/architecture.md) 和 [开发指南](./docs/development.md)。
2. 从 `main` 创建功能分支。
3. 修改代码并补充与风险相称的测试。
4. 更新受影响的当前文档。
5. 提交前运行相关质量检查。

## 提交要求

- 一个提交表达一个明确意图。
- 不提交真实账号、密码、密钥、服务器 IP 或用户素材。
- 不提交 Agent 会话、阶段计划、review round、coverage 或构建缓存。
- API 与数据结构变化必须说明兼容性和迁移方式。
- 新功能默认不应绕过项目权限、工作流持久化或模型网关。
- 渐进能力需要明确开关、观测和回滚路径。

## 最低检查

```bash
npm run docs:check
npm --prefix backend run lint:check
npm --prefix backend run test
npm --prefix backend run build
npm --prefix frontend run test
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

如果修改仅涉及文档，可以只运行文档检查和 `git diff --check`。数据库、队列、文件解析和 RAG 变更需要额外集成测试。

## Pull Request

PR 描述应包含：

- 修改内容和原因
- 用户或运维影响
- 数据库/API 兼容性
- 已执行的验证
- 已知限制和回滚方法
