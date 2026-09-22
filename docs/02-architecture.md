# 02 · 总体架构与关键机制

## 2.1 组件总览

单一 Worker、单部署单元（React 控制台走 assets binding，模板已配 `run_worker_first: /api/*`）：

```
                        ┌──────────── Worker（Hono）────────────┐
                        │                                        │
  客户端(apt/conda/…) ──▶ /s/{sourceId}/*   数据面：Lazy 代理 + 固化对象服务
  浏览器控制台        ──▶ /api/* + 静态UI   控制面：源 CRUD、任务、统计（better-auth 鉴权）
                        │                                        │
                        └───┬──────────┬───────────┬─────────────┘
                            │          │           │
                          D1        R2 三桶      Workflows（由 Cron / API 触发）
                  (映射/统计/配置)   ├ mirror-hot（Standard）
                                    ├ mirror-cold（Infrequent Access）
                                    └ robot-apt（外部只读，现有 aptly 产物）
```

- **Worker**：请求路由、Lazy 缓存、鉴权、限速、控制台 API。所有 IO 流式，不把对象读进内存。
- **D1**：逻辑文件 → 物理 blob 的映射、源配置、任务状态、访问统计。热路径经 isolate 内 LRU（60s TTL）缓存，miss 才读 D1。
- **R2**：字节存储。托管对象全部内容寻址（见 2.3），分布在 hot/cold 两桶；`robot-apt` 只读挂载。
- **Workflows**：Pinned 固化、全量校验、冷热迁移、GC 四类后台任务。Cron 只当启动器（15 分钟 wall-clock 干不了活）。
- **VPS：已从架构中删除。** 全部计算在 Cloudflare 上。

## 2.2 两种模式（本系统最重要的语义）

| | Lazy（按需缓存代理） | Pinned（预抓取固化） |
|---|---|---|
| 行为 | 请求未命中 → 回源拉取，边转发边落盘；命中 → 直接服务 | 主动把一组文件抓全、冻结、定期重校验 |
| 能防上游消失吗 | **不能**（只缓存了被访问过的部分） | **能**（这是它存在的唯一理由） |
| 适用 | conda-forge / PyPI（10TB+，物理上不可能全量） | ISO、小型 apt 仓库、关键工具链 |
| UI 承诺 | 永久标注「缓存 ≠ 备份」；仪表盘顶部固定列出「未固化的源」 | 显示「已固化 N 对象 / 上次校验时间 / 校验结果」 |

模式切换是显式操作：Lazy→Pinned 触发一次全量固化任务；Pinned→Lazy 需二次确认（销毁备份语义）。**只有 Pinned 源允许声称"已备份"。**

Lazy 模式透传上游原始字节，客户端用上游 key 验签——不重签名、不生成仓库元数据，**不在 Worker 里重新实现 aptly/reprepro**。推论：ROS 签名 key 反复过期的问题不因镜像而消失，那是客户端侧的既有负担，不是本系统要解决的问题。

现有 `robot-apt` 作为第三类源 **external-pinned** 只读挂载：Worker 侧维护**写入前缀白名单**，任何写路径的目标必须落在该源声明的可写前缀内；`ros/`、`ubuntu/`、`blobs/` 配为只读，从代码层面保证不碰现有产物。

## 2.3 D1 数据模型：逻辑文件 → 物理 blob（借鉴 storage-ts）

参考 [storage-ts](https://github.com/Vankyle-Hub/storage-ts)（`File → FileVersion → Blob` 三层 + `blob_references` 引用计数），针对镜像场景裁剪：**去掉目录树和版本历史**（上游路径即层级，上游即历史），**blob 改为内容寻址**（storage-ts 用 uuid key、未实现去重，我们不采用这一点）。

```
sources        id, name, adapter(apt|conda|pypi|static), mode(lazy|pinned|external-pinned),
               base_url, allow_insecure_http, write_prefix, access_level(public|token),
               noindex, daily_bytes_cap, status, created_at, updated_at
source_tokens  id, source_id, token_hash, label, created_at, revoked_at
files          id, source_id, path, current_blob_id→blobs.id, state(present|missing),
               upstream_etag, upstream_last_modified, pinned, created_at, updated_at
               UNIQUE(source_id, path)
blobs          id, sha256 UNIQUE NULL, bucket, r2_key, size, refcount,
               tier(hot|cold|external), status(active|orphaned|pending-deletion),
               fetched_at, verified_at, verify_status(ok|failed|unverified),
               last_access_at, access_count
jobs           id, type(ingest|verify|tier|gc), source_id, workflow_instance_id,
               status, progress_json, created_at, finished_at
```

映射链：`files(source_id, path) → blobs.id → (bucket, r2_key)`。

- **托管 blob 的 R2 key 是内容寻址的**：`objects/{sha256前2位}/{sha256}`。这是去重和幂等重抓的基础。
- **外部 blob**（robot-apt 里的现有对象）：`r2_key` 存真实 key，`tier=external`，`sha256` 在首次校验前为 NULL。由扫描任务（ListObjects 分页）物化 files/blobs 行，首次访问时也可懒物化。
- **mutable 文件更新**：上游内容变化 → 新 blob 落盘 → `files.current_blob_id` 原子切换 → 旧 blob refcount 减一 → 归零进入 GC。指针切换前旧版本持续可服务，无窗口期。
- storage-ts 中**未实现、需要我们自建**的部分：sha256 去重写入路径、孤儿 blob 的物理 GC、冷热分层、访问统计（该项目只有 `blobs.storage_class` 被动字段和 `findBlobBySha256` 查询口）。
- 迁移工具沿用模板已有的 Kysely（与 storage-ts 的 D1 Kysely dialect 选型一致）。

### 热路径读流程（Lazy 命中）

1. URL 解析出 `source_id` + `path`（纯计算，不查库）；
2. LRU 查 `(source_id, path) → (bucket, r2_key)`，miss 则查 D1 并回填（D1 读在 Paid 计划每月含 250 亿行，实质上免费，延迟 1–5ms）；
3. R2 `get(r2_key, {range})` 流式返回；
4. 访问统计采样更新（见 2.5）。

## 2.4 去重（CAS）写入路径

Lazy 回源时 sha256 未知，无法直接写 CAS key，流程为：

1. 流式 tee：一路回客户端，一路写入临时对象 `tmp/{uuid}`（≤4GiB 单 PUT；更大走流式 multipart，见 2.6）；
2. 传输全程流式计算 SHA-256；
3. 完成后按 sha256 查 `blobs`：
   - **已存在**（跨源重复 / 重复抓取）→ 删除临时对象（Delete 免费），`files` 指向既有 blob，refcount+1；
   - **不存在** → `CopyObject` 到 `objects/{sha256:2}/{sha256}`（server-side，无流量），删除临时对象，插入 blob 行。
4. 客户端中途断连 → 临时对象不落索引，由定期清扫删除（或转入 multipart abort）。

代价是每新对象多 2 次 Class A 操作（Copy + Delete），单价 $4.50/M，可忽略。换来：同一 deb 出现在多个源、同一 ISO 被多个源引用时只存一份；重抓已存在内容零存储增长。

## 2.5 冷热分层（双桶 + D1 访问统计）

- `mirror-hot` = Standard（$0.015/GB-月）；`mirror-cold` = Infrequent Access（$0.01/GB-月 + **取回 $0.01/GB** + 30 天最低存储期 + 操作单价 2 倍）。
- **盈亏平衡**：每 GB 每月省 $0.005，每次取回罚 $0.01 → 对象读取频率低于约 **1 次 / 2 个月** 时 IA 才划算。这正是要用 D1 实际访问数据驱动决策、而不是拍脑袋分层的原因。
- 统计口径：每次命中服务更新 `blobs.last_access_at`；`access_count` 用**隔离岛内累计 + 定期批量 flush**（避免热路径每请求一次 D1 写；近似值对分层决策足够）。另用 Workers Analytics Engine 记全量请求指标供仪表盘（命中率、带宽、Top N）。
- 迁移任务（Workflow，Cron 每日触发）：SQL 选出候选（`age > 30 天` 且 `access_count` 折算频率低于阈值 且 非 mutable 小文件——**索引类可变文件永不下沉**，它们又小又热）；逐个 `CopyObject` hot→cold → 校验 size/etag → 更新 `blobs.bucket/tier` → 删除 hot 侧对象。回热：冷对象被访问时照常服务（付一次取回费），若访问频率回升则反向迁移。
- Pinned 源默认整体下沉 cold（其价值是"存在"而非"快"），但保留源级开关。

## 2.6 Workflows 详解：调度方式与下载/固化实现

### 概念

Cloudflare Workflows 是持久化工作流引擎：一个 Workflow 是一个类（`WorkflowEntrypoint` 子类），**一次运行是一个实例**。核心机制：

- **创建/调度**：Worker 代码里 `env.PIN_WORKFLOW.create({ id, params })` 即启动一个实例（可由控制台 API 调用触发，或由 Cron Trigger 定时触发——Cron 本身只有 15 分钟 wall-clock，所以它的职责只是"创建实例"）。实例可查状态、可暂停/恢复/终止。
- **步骤（step.do）**：`run()` 内的工作切成命名步骤。每个步骤的**返回值被持久化**；实例崩溃/重启后从**最后一个完成的步骤**续跑，已完成步骤直接返回缓存结果不重跑。每步可配独立重试策略（次数、指数退避）。
- **为什么适合大文件下载**：单步 wall-clock **无上限**（等待网络 I/O 不耗 CPU 配额）；步数上限可调至 25,000；子请求可调至 10M；步骤结果只存小元数据（≤1MiB），字节本体直接写 R2（官方推荐用法）。
- **限制**：单步 CPU 默认 30s（可调 5 分钟）——流式管道几乎不耗 CPU，不构成约束；单实例持久化状态 ≤1GB——分片元数据（part number + etag）按 KB 计，远不及。

### Pinned 固化流水线（ingest job）

```
create({ sourceId, fileList })                    ← 控制台按钮 / Cron
  step: expand         解析 fileList（目录类源用上游索引展开成文件清单）
  per file:
    step: head         HEAD 上游，记录 ETag + Last-Modified + size
    step: create-mp    R2 CreateMultipartUpload（>4GiB 或未知大小时；小文件直接单 PUT 步骤）
    per part (64MiB):  ← 6GB ISO ≈ 96 步，远低于 25,000 步上限
      step: part-N     fetch(Range + If-Range=初始ETag) → UploadPart → 返回 {partNumber, etag}
                       失败独立重试（指数退避）；ETag/Last-Modified 变化 → 抛错
    step: complete     CompleteMultipartUpload → 得临时对象
    step: finalize     流式重读临时对象计算 SHA-256（1 次 Class B，无流量费）→
                       有上游校验和（如 SHA256SUMS / repodata）则比对，不符即失败 →
                       CAS 落位 + D1 指针切换（同 2.4 第 3-4 步）
  step: report         汇总写入 jobs 表（成功数、失败清单、总字节）
```

对应第四节②的三个失败模式：

- **上游不支持 Range** → 降级为单 step 内顺序流：边收边攒 32MiB buffer 逐个 UploadPart（内存峰值 ~32MiB，128MB 限内）。**M0 必须实测此路径。**
- **传输中途上游文件变了** → `If-Range` 使上游在文件变化时对新 part 返回 200 而非 206，步骤检测后立即 **abort 整个 multipart 并标记任务失败**，绝不拼出损坏文件；不支持 If-Range 的上游则逐步比对响应头 ETag/Last-Modified。
- **分片中断恢复** → 步骤级重试 + 实例续跑；实例彻底失败 → 错误路径显式 AbortMultipartUpload（免费）+ bucket 7 天 lifecycle 自动 abort 兜底 + 任务启动时 ListMultipartUploads 清扫同 key 残留。

### 其余三类 Workflow

- **verify**（Pinned 重校验）：遍历源的 files → 逐 blob range 流式重算 SHA-256 → 比对 D1 → 报告（UI 显示时间+结果）。
- **tier**（冷热迁移）：见 2.5。
- **gc**：扫描 `orphaned/pending-deletion` blob → 物理删除；清扫 `tmp/` 前缀残留。

### 任务状态可视化

`jobs` 表与 Workflow 实例 id 绑定，关键步骤回写进度；控制台轮询 `/api/jobs/:id` 展示进度条与失败清单。

## 2.7 缓存策略：可变 / 不可变 / 透传

所有镜像站最经典的 bug 来源，由适配器的**路径分类规则**（有序 regex，可在控制台覆盖单条）解决：

| 类别 | 例子 | 策略 |
|---|---|---|
| `immutable` | `pool/**` 的 deb、`.conda`/`.tar.bz2`、wheel、`/dists/*/by-hash/SHA256/*`（bionic apt 的 by-hash 天然不可变，适配器必须识别） | 永久缓存，命中即服务，不回源 |
| `mutable` | `Release`/`InRelease`、`Packages.*`、`repodata.json`、PyPI simple index | 有缓存也**先向上游发条件请求**（If-None-Match / If-Modified-Since）；304 用缓存，200 更新缓存并切换 blob 指针；**上游不可达且有缓存 → 服务陈旧缓存并记日志**（EOL 场景正是要这个） |
| `passthrough` | 兜底默认 | 不缓存 |

搞反的后果是具体的：索引缓存太久 → 客户端拿旧索引请求已消失的包 → `404 Hash Sum mismatch`；不可变文件不缓存 → 系统白建。

**>5GiB 对象的 Lazy 落盘**（ISO 超过 R2 单 PUT 上限）：tee 流时并行做流式 multipart（边下边攒 64MiB 传 part）；客户端中途断连 → abort multipart，不留半截对象。

检测到上游 416 或校验失败时**清除缓存条目**，不把坏字节留给下次请求。

## 2.8 Range 与断点续传

设计阶段内置：命中 R2 → 解析 `Range` 头映射到 binding 的 `{offset,length}`/`{suffix}` → 返回 206 + `Accept-Ranges: bytes` + 正确 `Content-Range`；回源时 Range 原样透传。多段 Range（`bytes=1-2,5-6`）拒绝，apt 和浏览器都不需要。

## 2.9 SSRF 与滥用防护（安全红线）

- **无通用代理**：代码中不存在任何"从请求参数取 URL"的路径；上游 URL = 注册的 `base_url` + 路径后缀拼接。
- 注册时校验：默认要求 https（ROS snapshots 这类 http 源需显式勾 `allow_insecure_http`）；解析域名并 **DNS 解析后**拒绝私有/保留网段（RFC1918、loopback、link-local 含 `169.254.169.254`、100.64/10）；回源重定向逐跳做同样校验，最多 3 跳。
- 每源访问级别：`public` / `bearer`（令牌哈希存 `source_tokens`）。**不用短时效 JWT**——Nano 无 RTC 电池、时钟会飘。
- 限速两层：L0 = zone WAF 免费规则兜底极端流量；L1 = 每源每日字节硬上限（`daily_bytes_cap`，异步计数，超限 503）——R2 操作按量计费，这层是账单保险，P0 不省。精确滑动窗口限速（DO）在 P1。
- `noindex`：Worker 无条件给所有镜像响应加 `X-Robots-Tag: noindex`。

## 2.10 鉴权（better-auth + OIDC，无 Cloudflare Access）

- 控制台 UI 与 `/api/*` 写操作：better-auth session，配置 **genericOAuth 插件对接 `auth.zhuoling.space`（OIDC provider）**。模板已内置 better-auth，改造点是把它从本地凭证模式切到 OIDC client 模式。
- Node 逃生通道用同一套 better-auth（OIDC 与部署形态无关，这也是放弃 Access 的收益之一）。
- 数据面（`/s/*`）：public 源直接服务；token 源校验 `Authorization: Bearer`（哈希查 `source_tokens`）。
- 鉴权失败一律 401/403，不泄露源是否存在。

## 2.11 TLS 与老客户端

按 **min TLS 1.3 开发**（zone 默认不动）。已知风险：Nano 上 apt 1.6 的 https method 走 GnuTLS 3.5（无 TLS 1.3），大概率连不上；OpenSSL 1.1.1 本身支持 1.3，curl/openssl 层面没问题。**M2 设专项实测检查点**；若不通，备选（届时再定，不预建）：按 hostname 放宽（需 ACM 订阅）、镜像独立 zone、或 Nano 侧走 http + 局域网/隧道。
