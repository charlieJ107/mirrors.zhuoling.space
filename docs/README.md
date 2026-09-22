# 镜像站设计文档

自托管镜像站（Cloudflare Workers + R2 + D1 + React 控制台）的设计文档。本目录为**第二轮修订版**，相对第一轮的变更：

1. 鉴权统一为 better-auth（OIDC provider：`auth.zhuoling.space`），**不使用 Cloudflare Access**。
2. 删除 VPS executor，全部计算在 Cloudflare 上（Pinned 预抓取用 Workflows + R2 multipart）。
3. D1 承担逻辑文件 → R2 对象的映射（借鉴 [storage-ts](https://github.com/Vankyle-Hub/storage-ts) 的三层模型），R2 key 改为内容寻址以支持跨源去重。
4. 新增基于 D1 访问统计的双桶（Standard / Infrequent Access）冷热分层。
5. TLS 按 min TLS 1.3 开发，Jetson Nano 兼容性留作 M2 的实测检查项。

## 目录

- [01-platform-limits.md](01-platform-limits.md) — Cloudflare 平台限制核实（2026-09-22 查证，含来源）
- [02-architecture.md](02-architecture.md) — 总体架构与关键机制（Workflows 详解、D1 数据模型、去重、冷热分层、缓存策略、安全、鉴权）
- [03-adr.md](03-adr.md) — 架构决策记录（含对原始五条判断的表态）
- [04-feature-list.md](04-feature-list.md) — P0 / P1 / P2 功能清单
- [05-milestones.md](05-milestones.md) — 里程碑与验收标准

状态：**待审核**。批准后从 M0（大对象 ingest spike）开始实施。
