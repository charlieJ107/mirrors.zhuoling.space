# M0 ingest spike 结果：Workflows + R2 multipart 大对象抓取

> 关联 issue #1；验证代码在 `spikes/m0/`（一次性，可删）。验证日期 2026-09-22。
> 对应 `docs/05-milestones.md` M0 验收 1–4 的**本地等效验证**；真实 ~6GB
> Ubuntu ISO 的远程实跑待 Cloudflare 凭据到位后按 `spikes/m0/run-remote.md` 执行。

## 环境与方法

- `wrangler dev`（wrangler 4.136.2 / workerd 1.20260921.1）本地模拟 R2 bucket
  与 Workflows binding（均确认为 local mode）。
- mock 上游 `spikes/m0/upstream/server.mjs`：确定性生成的 200 MiB 测试文件
  （xorshift32 PRNG，两种种子 = 两个不同内容/ETag），支持 ETag 轮换（内容同时
  切换）、Range 开关、限速、请求日志（兼作 fetch subrequest 计数器）。
- 编排 `node spikes/m0/driver/run-all.mjs`：4 场景全自动，结果落
  `spikes/m0/results/*.json`（已提交）。
- 200 MiB = 3×64MiB + 8MiB 尾片（ranged 路径 4 分片；sequential 路径
  32MiB×7 分片），特意用非整除尺寸覆盖末片余数逻辑。

## 结果总览（全部通过）

| # | 场景 | M0 验收 | 结果 | 关键证据 |
|---|---|---|---|---|
| 1 | happy path（Range 上游，64MiB 分片） | 验收 1（本地尺度） | ✅ | workflow 报 sha256 与源文件一致，且**独立重新下载对象复算**也一致 |
| 2 | 传输中途 ETag 变化 | 验收 2 | ✅ | If-Range 使第 3 个分片收到 200 → NonRetryableError → 实例 errored；对象不存在；registry 为空（abort 已执行） |
| 3 | 上游不支持 Range | 验收 3（本地尺度） | ✅ | 自动降级 sequential；7×32MiB；sha256 一致；2×HEAD + 1×GET-200 |
| 4 | 中断 + 孤儿 multipart 清理 | 验收 4 | ✅ | 手工孤儿 + terminate 真实实例各一，sweeper 全部 abort，registry 清零，无残留对象 |

## 量化数据（本地）

**场景 1（ranged, 200 MiB, 4 分片）**
- wall-clock 37.3s（workflow 自报 37.0s）。注意：这是 workerd 本地模拟
  （R2 落在同进程 SQLite）的速度，不代表远程。
- 上游请求：1 HEAD + 4 GET(206)，共 200 MiB，无一次 200/重试。
- R2 binding 操作（workflow 自报计数）：createMultipartUpload 1 + uploadPart 4
  + complete 1 + get 1 + registry put/delete 各 1 = **10 次**。
- 外推到 6GB ISO（96 分片）：fetch 类 97 次 + R2 类 ~101 次 ≈ **200 subrequests**，
  远低于 Workflows 默认 10,000 上限；步数 96+4 ≪ 25,000 上限。设计估算成立。

**场景 3（sequential, 200 MiB, 7 分片）**
- wall-clock 25.1s；上游请求恰好 2 HEAD（probe + 完成后复查）+ 1 GET(200 全量)。
- 内存：workerd 进程 RSS 基线 480MB → 峰值 579MB，**增量 ~98MB** ≈ 32MiB
  buffer + 单次拷贝 + 运行时杂项。缓冲区按设计封顶（PartChunker 有单测保证
  buffered < partSize + 一个输入 chunk）。注意本地 workerd 不强制 128MB
  isolate 限制，该数字是趋势证据而非合规证明；远程复测见 run-remote.md。

**场景 2（etag-change）**
- 第 3 分片请求带 `If-Range: <旧etag>`，上游按 RFC 9110 回 200 全量 →
  分片步骤抛 NonRetryableError → catch 路径执行 abort（registry 清空可证）→
  实例状态 `errored`（`WorkflowFatalError: ... NonRetryableError ... not handled`，
  重抛是我们有意为之：实例必须失败）。
- 已传字节约 135MB 全部作废；R2 中无对象、无在途 MPU。

**场景 4（orphan-sweep）**
- `terminate()` 真实运行中实例（8MB 已传）→ 实例 `terminated`，错误路径
  **不会**执行（实例被杀，catch 不跑）——这正是 sweeper 存在的意义。
- sweeper 一次调用 abort 两个孤儿 MPU，幂等（二次运行零操作）。

## 设计相关发现（回填架构文档的素材）

1. **R2 Workers binding 没有 `listMultipartUploads`**（@cloudflare/workers-types
   20260922.1 实测：只有 `createMultipartUpload` / `resumeMultipartUpload`）。
   §2.6 设想的"任务启动时 ListMultipartUploads 清扫"在 binding 路径下不可行。
   本 spike 用桶内 registry marker 对象（`__mpu_registry__/<uploadId>`，create 后
   写入、complete/abort 后删除，各多 1 次 Class A 操作）实现等价清扫；S3 API 的
   ListMultipartUploads 留给远程 run 交叉验证（需要 R2 API token）。**架构决策点**：
   产品代码要么沿用 marker 方案，要么为清扫器配 S3 凭据。
2. **`resumeMultipartUpload(key, uploadId)` 跨步骤可用**，multipart 状态在步骤间
   的传递只需持久化 `(key, uploadId, [{partNumber, etag}])`——KB 级，远低于单步
   返回值 1MiB / 实例状态 1GB 限制。§2.6 的分片方案可行。
3. **`NonRetryableError` 的类型在 `cloudflare:workflows` 模块**（文档示例多写
   `cloudflare:workers`；当前 workers-types 中后者不导出它）。运行时两者皆可，
   但 tsc 只认 `cloudflare:workflows`。
4. **If-Range 的防线是有效的**：上游严格遵守 RFC 9110 时，文件变化必然在下一个
   分片请求处暴露为 200。但对忽略 If-Range 的上游，响应头 ETag/Content-Range
   比对这条后备防线必须保留（代码里已双层实现）。
5. **无 Range 上游无法检测传输中途变化**，只能在 complete 前用尾随 HEAD 比对
   ETag/size（已实现）。这是该路径的固有风险，文档 §2.6 的描述与此一致。
6. 小坑：Hono 的 `:param` 不匹配含 `/` 的 key——产品 API 里对象 key 路由要用
   通配符（spike 里已按此实现）。
7. 本地 `__LOCAL_DEV_STEP_OUTPUTS` 字段会在实例 status 里暴露每个 step 的返回
   值，调试 Workflows 很有用（仅本地）。

## 本地未覆盖 / 待远程验证

- 真实 ~6GB 尺度：96 分片的 wall-clock、单步 p50/p95、subrequest 计量页面读数、
  CPU 时间（验证"流式几乎不耗 CPU"）、finalize 流式 sha256 在真实 workerd 的吞吐。
- 128MB isolate 内存硬约束下的 sequential 路径（本地不强制）。
- S3 API ListMultipartUploads 与 registry marker 清扫的交叉验证。
- bucket 7 天 lifecycle 自动 abort 兜底（本地不可验）。
- 与官方 `SHA256SUMS` 的比对（真实 ISO）。

步骤见 `spikes/m0/run-remote.md`。
