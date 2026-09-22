# 01 · Cloudflare 平台限制核实

2026-09-22 查证，全部来自当日抓取的官方文档（developers.cloudflare.com），"更新"列为页面元数据的最后修改日期。本表是后续一切架构决策的前提。

## Workers 运行时

| 项目 | 数值 | 来源（更新） |
|---|---|---|
| CPU 时间 | Free 10ms；Paid 默认 30s，可调至 **5 分钟** | [limits](https://developers.cloudflare.com/workers/platform/limits/)（2026-09-05） |
| HTTP 请求 wall-clock | **无硬性上限**，客户端保持连接即可持续流式输出 | 同上 |
| Subrequest | Free 50；Paid 10,000/请求，可调至 10M（R2/D1 等 binding 访问也计数） | 同上 |
| Request body | Free/Pro **100MB**；Enterprise 最高 5GB（413 超限） | 同上 |
| **Response body** | **无大小上限**（512MB 是 CDN 缓存限制，非响应限制） | 同上 |
| 内存 | 128MB；buffer 整个大 body 会 OOM，**必须流式** | 同上 |
| `ctx.waitUntil` | 响应结束后最多再执行 **30 秒** | [context](https://developers.cloudflare.com/workers/runtime-apis/context/)（2026-09-10） |
| Paid 计费 | $5/月起；含 1000 万请求 + 3000 万 CPU-ms；超出 $0.30/M 请求、$0.02/M CPU-ms；**wall-clock 不计费** | [pricing](https://developers.cloudflare.com/workers/platform/pricing/)（2026-08-28） |

推论：Lazy 模式单请求流式转发 6GB 文件可行（响应体无上限、wall-clock 无上限、流式几乎不耗 CPU）。但"响应结束后再落盘"不可行（waitUntil 仅 30 秒）——**落盘必须与响应流并行 tee 完成**。

## R2

| 项目 | 数值 | 来源（更新） |
|---|---|---|
| 单次 PUT 上限 | **5 GiB**（精确 4.995 GiB） | [limits](https://developers.cloudflare.com/r2/platform/limits/)（2026-06-08） |
| Multipart | part 5MiB–5GiB；最多 **10,000 parts**；对象最大 5 TiB；除末 part 外必须等大 | [multipart-objects](https://developers.cloudflare.com/r2/objects/multipart-objects/)（2026-07-29） |
| 孤儿 multipart | 默认 **7 天自动 abort**（lifecycle 可改）；未完成 multipart 计存储费；Abort 免费 | 同上 |
| Binding range 读 | `get(key, {range})` 支持 `{offset,length}` 与 `{suffix}` | [workers-api-reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)（2026-07-31） |
| 条件写 | binding `onlyIf`（etagMatches / uploadedBefore 等）；S3 API If-Match 等四条件头已实现 | 同上 + [s3 api](https://developers.cloudflare.com/r2/api/s3/api/)（2026-07-31） |
| 价格 | Class A $4.50/M；Class B $0.36/M；Standard 存储 $0.015/GB-月；**egress 免费**；Delete 免费；免费额度 10GB + 1M A + 10M B | [pricing](https://developers.cloudflare.com/r2/pricing/)（2026-08-07） |
| Infrequent Access | 存储 $0.01/GB-月；**取回 $0.01/GB**；最低存储期 30 天；Class A/B 单价均为 Standard 的 2 倍 | 同上 |
| 自定义 metadata | 8 KiB/对象；key ≤ 1024 字节 | limits 页 |
| r2.dev 子域 | 可变速率限制（"每秒数百请求"），不可用于生产 | [public-buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)（2026-06-16） |

推论：Ubuntu ISO（5–6GB）**超过单次 PUT 上限**，无论 Lazy 还是 Pinned，大对象都必须走 multipart。跨桶复制用 S3 `CopyObject`（同账户 server-side，无下载/上传流量）——冷热分层迁移依赖此能力。

## Workflows / Queues / Durable Objects / Containers / Cron

| 项目 | 数值 | 来源（更新） |
|---|---|---|
| Workflows 单步 wall-clock | **无上限**（I/O 等待不计 CPU） | [limits](https://developers.cloudflare.com/workflows/reference/limits/)（2026-09-21） |
| Workflows 步数 | 默认 10,000/实例，可调至 **25,000**（`step.sleep` 不计） | 同上 |
| Workflows 子请求 | 默认 10,000/实例，可调至 10M | 同上 |
| Workflows 状态 | 单步返回值 ≤1MiB；实例持久化状态 ≤1GB；每步最多重试 10,000 次（指数退避） | 同上 |
| Workflows 并发 | 50,000 running 实例/账户；创建速率 300/秒 | 同上 |
| Queues | 消息 ≤128KB；consumer 批次 ≤100 条；batch timeout ≤60s；consumer 单次 wall-clock 15 分钟 | [limits](https://developers.cloudflare.com/queues/platform/limits/)（2026-04-21） |
| Durable Objects | alarm wall-clock 15 分钟；duration 按 GB-s 计费（可休眠免计） | [limits](https://developers.cloudflare.com/durable-objects/platform/limits/)（2026-06-01） |
| Containers | 2026-04-13 **GA**；磁盘全 ephemeral；**egress 收费**（北美/欧洲 $0.025/GB） | [changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/) |
| Cron Trigger | 单次 wall-clock 15 分钟；只配当启动器 | [limits](https://developers.cloudflare.com/workers/platform/limits/)（2026-09-05） |

推论：**Workflows 是 Pinned 预抓取的正确原语**（单步 wall-clock 无上限 + 每步独立重试 + 状态持久化），Queues/DO/Cron 均因 15 分钟 wall-clock 或语义不匹配而排除；Containers 对本场景无优势（ephemeral 盘 + egress 收费）。

## 边缘配置与鉴权相关

| 项目 | 数值 | 来源（更新） |
|---|---|---|
| Minimum TLS Version | zone 级设置，Free 可用，可选 1.0–1.3；**按 hostname 设置需 Advanced Certificate Manager（付费）** | [minimum-tls](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/)（2026-08-14） |
| WAF 速率限制 | Free 仅 1 条规则、10 秒固定窗口、只能按 IP | [rate-limiting-rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)（2026-08-25） |
| Static assets | 单文件 25MiB；Paid 10 万文件；资产请求免费不限量；`run_worker_first` 支持前缀 | [limits](https://developers.cloudflare.com/workers/platform/limits/)（2026-09-05） |
| Cache API | 对象 ≤512MB；Paid 1,000 次/请求；**被 Access 保护的 Worker 不可用** | [cache](https://developers.cloudflare.com/workers/runtime-apis/cache/)（2026-08-14） |
| Workers Custom Domains | 自动签发证书；每 zone 100 个；不支持通配符 | [custom-domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)（2026-08-14） |

推论：既然鉴权改用 better-auth（不上 Access），Cache API 不可用的约束自动消失（但本设计不依赖 Cache API，缓存层在 R2+D1）。
