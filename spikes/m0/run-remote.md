# M0 spike — 远程实跑手册（真实 ~6GB Ubuntu ISO → 真实 R2）

> THROWAWAY spike (issue #1)。前置条件：Cloudflare 凭据已配置（`wrangler login` 或
> `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`），且账户为 Workers Paid 计划。

本手册对应 `docs/05-milestones.md` M0 的实跑部分。本地已验证的内容（见
`docs/spikes/m0-ingest.md`）不需要远程重复；远程重点是**真实尺度**（~6GB、96 个
64MiB 分片）与**真实平台约束**（每步 CPU 上限、subrequest 计费、R2 S3 API 的
ListMultipartUploads）。

## 0. 准备（一次性）

```bash
# 在 worktree 根目录
npm ci
cd spikes/m0

# 1) 创建测试桶（不要用 robot-apt / 任何生产桶）
npx wrangler r2 bucket create m0-ingest-spike

# 2) 本地生成预期 SHA-256（任选其一）
#    直接下载官方校验和：
curl -LO https://releases.ubuntu.com/24.04.3/SHA256SUMS   # 以当日实际版本为准
grep desktop SHA256SUMS
```

选一个真实的 ~6GB 上游（默认用 Ubuntu releases 的 desktop ISO；也可换清华/阿里
镜像站对比延迟）：

```
ISO_URL=https://releases.ubuntu.com/24.04.3/ubuntu-24.04.3-desktop-amd64.iso
```

## 1. 部署 spike worker

```bash
npx wrangler deploy --config spikes/m0/wrangler.jsonc
# 记录分配的 workers.dev 域名，下文记作 $WORKER
```

## 2. 场景 A：happy path（M0 验收 1）

```bash
curl -X POST $WORKER/ingest -H 'content-type: application/json' -d '{
  "url": "'$ISO_URL'",
  "key": "iso/ubuntu-desktop-amd64.iso"
}'
# -> {"id":"<instanceId>"}

# 轮询直到 complete（~96 个 part step，预计几分钟到十几分钟）
curl $WORKER/instances/<instanceId>
```

验收：

- `output.ok == true`，`output.path == "ranged"`，`output.parts == ceil(size/64MiB)`；
- `output.sha256` 与官方 `SHA256SUMS` **一致**；
- 独立复核：把对象下载回来（或直接 `curl $WORKER/objects/iso/ubuntu-desktop-amd64.iso | sha256sum`）；
- 在 Cloudflare 面板/日志记录：Workflow 实例的 subrequest 总数、总 CPU 时间、
  wall-clock；回填 `docs/spikes/m0-ingest.md`。

## 3. 场景 B：中途 ETag 变化 → abort（M0 验收 2）

真实上游无法人为改文件，用两层验证：

1. **已被本地 mock 覆盖**（见 docs/spikes/m0-ingest.md 场景 2）——If-Range → 200
   → NonRetryableError → abort 的逻辑与平台无关。
2. 远程补一个**弱条件版本**：对 `releases.ubuntu.com` 上正在轮换的文件（如
   `SHA256SUMS` 本身或 daily-live 镜像）跑 ingest，或先用场景 A 的 key 重跑、
   中途人工在 R2 侧删除对象观察失败路径。
   关键验收不变：实例 errored；`curl -I $WORKER/objects/<key>` 为 404；
   `aws s3api list-multipart-uploads --bucket m0-ingest-spike --endpoint-url
   https://<accountid>.r2.cloudflarestorage.com` 输出为空。

## 4. 场景 C：无 Range 上游（M0 验收 3）

本地已用 mock 验证内存安全的顺序路径。远程复现可选一个不回
`Accept-Ranges: bytes` 的真实 HTTP 源，或把 mock upstream 部署到任意公网
VPS（`node server.mjs --port 80 --size 6442450944`，`/control/range
{"enabled":false}`）。验收：`path == "sequential"`，SHA-256 一致；在
Cloudflare 观测该 step 的内存/CPU（顺序路径是单 step 跑完 ~6GB，重点确认
不触 CPU/内存上限）。

## 5. 场景 D：中断清理（M0 验收 4）

```bash
# 起一个大文件 ingest，中途 terminate
curl -X POST $WORKER/instances/<id>/terminate
# 清扫器（registry-marker 路径，binding 没有 listMultipartUploads —— 见结果文档）
curl -X POST $WORKER/sweep -H 'content-type: application/json' -d '{"olderThanMs":0}'
# 交叉验证（S3 API，需要 R2 API token）：
aws s3api list-multipart-uploads --bucket m0-ingest-spike \
  --endpoint-url https://<accountid>.r2.cloudflarestorage.com
```

验收：sweep 返回被 abort 的 uploadId；S3 侧 ListMultipartUploads 为空；
无残留对象。

## 6. 需要回填到 `docs/spikes/m0-ingest.md` 的远程数据

- 6GB 全程 wall-clock、Workflow 实例 subrequest 总数（计量页面或日志）、
  CPU 时间（验证"流式几乎不耗 CPU"的估算）；
- 单 part step 的 p50/p95 耗时（判断 64MiB 分片粒度是否合适）；
- finalize 流式 SHA-256 步的耗时与 CPU（node:crypto 在真实 workerd 的吞吐）；
- 与 `docs/01-platform-limits.md` 假设不符的任何平台行为。

## 7. 清理

```bash
npx wrangler r2 object delete m0-ingest-spike/iso/ubuntu-desktop-amd64.iso --config spikes/m0/wrangler.jsonc
npx wrangler delete --config spikes/m0/wrangler.jsonc
# 桶可留作后续 spike 使用，或一并删除：
npx wrangler r2 bucket delete m0-ingest-spike
```
