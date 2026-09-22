# 04 · Feature List

## P0 —— 没有这些系统就不成立

| 功能 | 为什么 P0 |
|---|---|
| Lazy 代理核心（流式、tee 落盘、Range/206） | 80% 价值来源；Range 事后补极难 |
| mutable/immutable/passthrough 三分类 + by-hash 识别 | 搞错 = 404 / Hash Sum mismatch，镜像站最经典 bug |
| D1 三层数据模型（sources/files/blobs）+ CAS key | **schema 级决策，上线后改不动**；去重、分层、校验全建立在它上面 |
| 写入前缀白名单 | 保护现有 aptly 产物的代码级保险 |
| 源注册 + SSRF 防护（白名单、私网段拒绝、重定向校验） | 安全红线 |
| 每源访问控制（public/bearer）+ 每日字节硬上限 + noindex | 「先跑后加鉴权」被明确禁止；字节上限是账单保险 |
| better-auth（OIDC → auth.zhuoling.space）保护控制台 API | 没有它加源还要 ssh |
| 落盘 SHA-256 记录 | 完整性一等公民，事后补要重抓全量 |
| **M0 spike：6GB ISO 端到端 ingest** | 走不通则 Pinned 架构重画，必须先做 |
| apt + static 适配器 | apt 是现有生产需求；static 验证抽象 |

## P1 —— 系统可信、可运营

| 功能 | 为什么 P1 |
|---|---|
| Pinned 固化任务（Workflows）+ 进度/重试/失败清单 | 防上游消失的唯一手段；依赖 M0 结论故排其后 |
| Pinned 全量重校验 + UI 显示结果 | 「已固化」无校验是空话 |
| 跨源去重写入路径 + 孤儿 blob GC（物理删除） | 去重的收益闭环；GC 不建则 orphaned 只增不减 |
| 冷热分层迁移（hot/cold 双桶，D1 统计驱动） | 用户明确需求；需积累访问数据才有意义，故非 P0 |
| 控制台 UI（模式强区分、固化状态、「缓存 ≠ 备份」） | 模式语义靠 UI 传达；服务端先行 |
| 命中率/带宽/存储/R2 操作数 + 账单估算（Analytics Engine） | 字节硬上限之外的第二道账单防线 |
| 配置导出/导入（JSON） | 灾难恢复前提 |
| conda + pypi 适配器 | 明确需求，当前无生产消费者 |
| 精确速率限制（DO 滑动窗口） | 字节硬上限先兜底 |
| 上游健康探测 + 失效告警 | EOL 场景核心诉求，MVP 期可人工看 |

## P2 —— 有余力再做

| 功能 | 为什么 P2 |
|---|---|
| docker registry / npm / crates 适配器 | registry 认证复杂；无现实需求 |
| 每源容量配额 + Lazy LRU 驱逐 | 存储 $0.015/GB-月，前期手动清理足够 |
| 缓存预热（主动 crawl Lazy 源） | Pinned 的子集，待 Pinned 稳定后衍生 |
| 外部源（robot-apt）参与去重/分层 | 需校验全量历史对象拿 sha256，收益待评估 |
| 多副本/跨桶灾备 | 单点在 CF 账户；配置导出 + 源可重建已够 |

~~VPS executor~~：**已删除**（用户决定，纯 Cloudflare）。
