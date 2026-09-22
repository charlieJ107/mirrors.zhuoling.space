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

## 远程实跑（2026-09-22，真实 Cloudflare + releases.ubuntu.com）

对象：`ubuntu-24.04.5.1-desktop-amd64.iso`，6,250,332,160 字节（5.82 GiB），
94 个 64MiB 分片。官方 [SHA256SUMS](https://releases.ubuntu.com/24.04.5.1/SHA256SUMS)：
`4da4a0c9035da8e68a59a838674f403f0a54472c78a83b4fb7f78d03588f85a7`。
环境：worker `m0-ingest-spike`（workers.dev），bucket `m0-spike-test`（**均已删除**）。

### Run 1（默认配置）：字节全对，finalize 步 CPU 超限

- 94 分片全部抓取成功（wall ~62 min，平均仅 ~1.7MB/s——上游到该边缘节点很慢），
  multipart complete 成功，对象落桶。
- **finalize（流式 SHA-256）步两次尝试均以 "Worker exceeded CPU time limit" 失败**
  （默认 30s CPU/步）。本地 workerd 不强制 CPU 上限，所以本地验证没暴露这一点。
- 独立验证：把桶内对象经 worker 完整下载回本地，`sha256sum` = 官方值 ✅。
  **结论：字节路径（Range 分片 → multipart → R2）完全正确，仅哈希步超 CPU。**

### Run 2（`limits.cpu_ms=300000` + spurious-200 重试修正）：全绿

- 实例 `complete`，wall-clock **461.8s**（~14MB/s；与 Run 1 差 8 倍 → 上游/边缘
  吞吐方差极大，产品侧不要对 wall-clock 设硬预期）。
- workflow finalize 自算 SHA-256 = 官方值 ✅（hashedBytes = 6,250,332,160）。
- R2 binding 操作恰好 **100 次**（1 create + 94 uploadPart + 1 complete + 1 get
  + 2 registry marker）；上游 fetch ≥95 次（1 HEAD + 94 GET + spurious 重试）→
  全实例 subrequest ≈ **200，为默认上限 10,000 的 2%**；步数 ~99 ≪ 25,000。
- 观测到实例状态 `waiting` = 步骤重试退避（spurious-200 重试时被看到）。

### 平台意外（相对本地 workerd，全部回填架构决策）

1. **默认 30s CPU/步不够对 6.25GB 流式算 SHA-256**（node:crypto）。产品侧选项：
   (a) Worker 显式 `"limits": {"cpu_ms": 300000}`（Paid 上限 5 min，spike 已验证
   可行）；(b) 把哈希摊进各 part 步做增量哈希——node:crypto 不能导出中间状态，
   需纯 TS 实现 SHA-256（可序列化 state）或 (c) 信任 multipart + 抽查。
   **建议 (a)，成本为零。**
2. **真实上游会"无视 Range 但文件没变"**：releases.ubuntu.com 约 **5%** 的请求对
   Range+If-Range 回 200 全量而 ETag 与 probe 完全一致（worker 侧
   `/diag/range-check` 三次 N=20 均恰为 1×200 + 19×206；本机直连 9/9 全 206——
   是边缘→源的多后端行为）。若按原设计把任何 200 视为"上游已变"并 abort，
   真实世界会大量误杀。已改为：**200 且 ETag 一致 → 可重试错误；ETag 变化 →
   NonRetryableError + abort**。§2.6 的失败模式表需要吸收这一层。
3. wrangler OAuth token **无 Workflows 管理 API 权限**（`workflows instances
   describe` 401，code 10000）；实例状态只能走 Worker 内 binding 或 Dashboard。
   产品控制面查询实例状态必须走 binding（spike 的 `/instances/:id` 已验证）。
4. **`wrangler r2 object delete` 报告 "Delete complete" 但对象实际未删除**
   （重复 3 次；binding `bucket.delete` 立即生效）。疑为 wrangler 4.136.2 的
   bug 或权限静默降级；产品代码用 binding 不受影响，运维脚本需注意复核。

### 远程孤儿清理（M0 验收 4 的真实平台复验）

- `terminate()` 真实运行中实例 → 状态 `terminated`，错误路径不执行，registry
  marker 残留 → sweeper 按 `keyPrefix` 精确 abort（同时验证了 prefix 过滤不误伤
  并行运行中的主 ingest）；手工孤儿 MPU（含 junk part）同法清理。
- 最终 `bucket.list()` 为空 → bucket 成功删除（R2 不允许删非空桶，此即净桶证明）。

### S3 ListMultipartUploads 交叉验证：未执行 + 产品建议

wrangler OAuth token 无法调 S3 兼容 API（需要单独创建 R2 API token，属账户级
敏感操作，未自行创建；本机也无 aws CLI）。**产品建议：清扫器以 registry marker
（或 D1 jobs 表）为唯一运行时依赖**——纯 binding、Worker 内闭环、无需额外凭据；
S3 ListMultipartUploads 仅作运维审计工具（token 由 maintainer 在 Dashboard 按需
签发）。registry 方案的固有缺口（CreateMultipartUpload 成功与 marker 写入之间的
崩溃窗口会产生不可见孤儿）由 bucket 默认 7 天 lifecycle 自动 abort 兜底，可接受。

### M0 验收对照（全部 ✅）

1. ✅ 真实 ~6GB ISO 经 Workflows + multipart 进 R2，SHA-256 与官方 SHA256SUMS
   一致（双重证据：Run 1 对象本地下载复算 + Run 2 workflow finalize 自算）。
2. ✅ 中途 ETag 变化 → abort、无残留（本地 mock 精确验证；远程观察到的 200 为
   spurious，已区分处理——见意外 #2）。
3. ✅ 无 Range 上游顺序路径（本地 200MiB 验证内存有界；远程未重复，同码路径）。
4. ✅ 中断清理（本地 terminate + 远程 terminate 各一次，sweeper 均生效）。
5. ✅ 本文件记录 wall-clock / subrequest / 步数 / CPU 边界。

### 清理状态

worker `m0-ingest-spike` 已 `wrangler delete`；bucket `m0-spike-test` 已删除
（删前 list 为空）；本地 `spikes/m0/testdata/`（含 6GB 下载件）与 `.wrangler`
本地状态已删除。账户侧无遗留存储/计费项。
