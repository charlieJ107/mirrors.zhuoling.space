# 03 · 架构决策记录（ADR）

## 对原始五条判断的表态（第一轮，经平台数据核实）

| # | 判断 | 表态 |
|---|---|---|
| 1 | Lazy/Pinned 双模式必须在 UI 强区分 | **同意并加强**：Lazy 源永久标注「缓存 ≠ 备份」；仪表盘固定列出未固化源；模式切换做成显式操作（Pinned→Lazy 二次确认）。 |
| 2 | conda-forge/PyPI 只能 Lazy | **同意**。10TB/20TB 量级物理上不可全量；其索引恰是可变小文件，Lazy + 条件回源是正确策略。 |
| 3 | Lazy 不重新签名 | **同意**。透传原始字节、验签留客户端，是相对 aptly 的结构性优势。推论：ROS key 过期问题不因镜像消失，属客户端既有负担，不在本系统范围。 |
| 4 | 重活留 VPS | **第一轮建议推翻 → 第二轮确认删除**。数据：6GB ISO = 64MiB × ~96 part ≈ 200 次 subrequest（Workflows 可调至 10M）；下载是纯 I/O 不耗 CPU；Workflows 单步 wall-clock 无上限、每步独立重试、状态持久化、孤儿 multipart 平台兜底。VPS 方案省不下有意义的钱，还多一个故障域。**架构中已无 VPS。** |
| 5 | 现有 aptly 产物零改动 | **同意并加保险**：`robot-apt` 只读挂载 + Worker 侧写入前缀白名单，代码层面（而非纪律层面）保证不碰 `ros/`、`ubuntu/`、`blobs/`。 |

第一轮被数据推翻的隐含前提："Worker 传大文件受 CPU 时间限制"——不准确。流式几乎不耗 CPU；真约束是 waitUntil 30 秒与非 HTTP 触发的 15 分钟 wall-clock，Workflows 均绕过。

## 决策列表

### ADR-1 Pinned 预抓取：Workflows + R2 multipart（纯 Cloudflare）
- 理由见 [01](01-platform-limits.md) Workflows 一节与 2.6。备选 Containers（GA 但盘 ephemeral + egress 收费）与 VPS daemon 均被否。
- 代价：Workflows 需要 Workers Paid（已购，确认非阻塞）。

### ADR-2 R2 key：内容寻址 `objects/{sha256:2}/{sha256}` + D1 三层映射
- 放弃"确定性 key（源+路径直算）"方案：它与去重不兼容（同一内容多个逻辑路径必须共享一个对象）。
- 热路径代价：一次 D1 索引读（LRU 缓存后 1–5ms，Paid 含 250 亿行/月，实质免费），换取跨源去重与分层迁移时逻辑路径零改动。
- 借鉴 storage-ts 的 File→Blob 分层与引用计数；不采用其 uuid key（无去重），GC/分层/统计需自建（该项目均未实现）。
- 规范化：不做 percent-decode 重编码（避免 `%2F`/`/` 歧义）；大小写原样；拒绝 `..` 与控制字符；key ≤1024 字节。

### ADR-3 缓存三分类 + 流式 tee 落盘
- 分类规则随适配器内置、控制台可覆盖；mutable 条件回源 + 上游不可达时服务陈旧缓存。
- 落盘与响应并行 tee（waitUntil 30 秒不支持"事后落盘"）；>5GiB 走流式 multipart tee。

### ADR-4 适配器抽象
- 纯函数集合，不碰 IO：`classifyPath` / `rewriteUpstreamUrl` / `extractIntegrity`（从 repodata/Packages/SHA256SUMS 提取校验和供固化校验）。
- 内置 apt、conda、pypi、static 四个；npm/crates 是加模块的事；docker registry 有认证流程，明确 P2。

### ADR-5 鉴权：better-auth + OIDC（auth.zhuoling.space），弃 Cloudflare Access
- 依用户决定。收益：与 Node 逃生通道同一套鉴权、无平台绑定；Cache API 限制顺带消失。
- 成本：要维护 session/回调逻辑（模板已有 better-auth 基础，改造为 genericOAuth client）。
- 数据面令牌为不过期静态 Bearer（哈希存 D1）——Nano 无 RTC，不用短时效 JWT。

### ADR-6 防滥用：注册制上游 + 私网段拒绝 + 每源每日字节硬上限
- 无 `?url=` 通用代理；DNS 解析后校验；重定向逐跳校验（≤3 跳）。
- WAF 免费规则仅兜底；字节硬上限是账单红线（R2 按操作计费）。

### ADR-7 完整性一等公民
- 落盘即算 SHA-256（流式），存 `blobs`；Pinned 可一键/定时全量重校验；Lazy 上游无校验信息时如实标 `unverified`，不假装验过。
- 上游 416/校验失败 → 清除缓存条目。

### ADR-8 双桶冷热分层（D1 统计驱动）
- 迁移用 server-side CopyObject，无流量费；IA 30 天最低存储期 → 只迁移 age>30d 且预测读取 <1 次/2 月的对象；可变索引文件永不下沉。
- Pinned 源默认 cold（可开关）。

### ADR-9 TLS：按 min TLS 1.3 开发
- 依用户决定，不预先降低 zone 设置。Nano 的 apt（GnuTLS 3.5）大概率不通，M2 实测检查点，备选方案届时再定（见 2.11）。

### ADR-10 桶布局
- 新桶 `mirror-hot` / `mirror-cold` 存本系统一切托管对象；`robot-apt` 只读挂载。生命周期规则互不干扰。
