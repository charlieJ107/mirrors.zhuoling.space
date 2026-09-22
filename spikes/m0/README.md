# M0 spike — Workflows + R2 multipart ingest（一次性验证代码）

> **THROWAWAY CODE — 本目录全部内容仅用于 M0 验证（issue #1），不作为产品代码。
> 验证完成后整个 `spikes/m0/` 可删除。不要 import 本目录到 `src/`。**

验证目标（对应 `docs/05-milestones.md` M0 与 `docs/02-architecture.md` §2.6）：

1. Workflows 实例按 64MiB 分片、Range + If-Range 抓上游 → R2 binding multipart upload；
   每片一个 `step.do`，独立重试；ETag 变化 → NonRetryableError → 显式 abort，绝不拼出坏对象。
2. 上游不支持 Range 的降级路径：单 step 顺序流，32MiB buffer 逐片 UploadPart。
3. 孤儿 multipart 清理：失败路径显式 abort + 清扫器（sweeper）兜底。
4. finalize：流式重读 R2 对象计算 SHA-256。

## 目录

- `src/` — spike Worker（Hono 控制面 + `IngestWorkflow`）与可单测的纯函数模块
- `upstream/server.mjs` — 可控 mock 上游（ETag 轮换 / 关闭 Range / 限速 / 内容切换）
- `driver/` — 场景编排脚本（本地起 upstream + `wrangler dev`，跑场景，落 `results/*.json`）
- `results/` — 本地验证结果（JSON，已提交作为证据）
- `run-remote.md` — 有 Cloudflare 凭据后跑真实 ~6GB Ubuntu ISO 的步骤

## 本地复现

```bash
npm ci                 # 根目录依赖（本机需 --ignore-scripts，见 PR 描述）
npm run test           # 纯函数单元测试（vitest）
node spikes/m0/driver/run-all.mjs   # 端到端 4 场景（自动起 upstream + wrangler dev）
```

结果与结论见 `docs/spikes/m0-ingest.md`。
