# 05 · 里程碑计划

每个里程碑的验收标准都是可执行命令或可观测指标。M1 之前不写 UI；M4 之前用 curl / 最简页面验证 API。

## M0 —— 大对象 ingest spike（纯验证，代码可扔）

目的：在写任何产品代码前验证 Pinned 主路径。No-go 则重评估 Containers 方案。

1. 临时 Worker 用 Workflows + multipart 把 Ubuntu Desktop ISO（~6GB）抓进 R2 测试桶，`sha256sum` 与官方 `SHA256SUMS` **一致**。
2. 人为制造中途 ETag 变化 → 任务 abort，R2 无残留对象，`ListMultipartUploads` 为空。
3. 对不支持 Range 的测试 HTTP 源完成 6GB 抓取（32MiB 顺序 buffer 路径，内存不炸）。
4. 中途 kill Workflow 实例 → 恢复/清理机制生效。
5. 记录全程 subrequest 数、CPU 时间、耗时，回填设计文档验证估算。

## M1 —— Lazy 数据面（无 UI，curl 可测）

1. `curl http://localhost:8787/s/{src}/dists/bionic/Release` 透传成功；二次请求由 R2 直接服务（日志无回源）。
2. `curl -H "Range: bytes=0-1023" .../x.iso` 返回 206 且字节正确；大文件全程内存平稳。
3. 上游 `Release` 变更 → 下次请求条件回源拿新版；`pool/` 文件二次请求零回源；`by-hash/SHA256/*` 按 immutable 处理。
4. 未注册路径 404；代码中无 `?url=` 取 URL 路径（grep 可证）；注册指向 `169.254.169.254` 的源被拒。
5. 无令牌访问 token 源 → 401；全部镜像响应带 `X-Robots-Tag: noindex`。
6. 两次注册内容相同的文件 → R2 中只有一个 CAS 对象，refcount=2。

## M2 —— 控制面 + 鉴权 + apt 端到端

1. 源 CRUD API 全部要求 better-auth session（OIDC 登录 `auth.zhuoling.space` 走通）；未认证写请求 403。
2. **Nano 的 `sources.list` 指向本 Worker，`apt update && apt install` 未缓存包成功**；`Acquire::Check-Valid-Until "false"` 写入运维文档。
3. **TLS 检查点**：Nano 实测 TLS 1.3 连通性。不通则启动 2.11 备选方案评估（不阻塞其余工作）。
4. `robot-apt` 挂载为 external-pinned 只读源，Nano 经它 `apt update` 成功；对 `ros/`、`ubuntu/`、`blobs/` 的写尝试被白名单拒绝（有测试）。

## M3 —— Pinned 模式 + 完整性 + 去重闭环

1. 注册 pinned 源（小目录起步）→ 固化完成后 API 显示「已固化 N 对象」；断开上游模拟消失，pinned 路径全部仍可下载。
2. 一键重校验跑通；人为改坏一个对象 → 校验报告标红该对象。
3. 6GB ISO 的 pinned 固化在产品代码路径复现 M0 结果（SHA256 一致）。
4. 删除源/取消固化 → refcount 归零 → GC Workflow 物理删除，R2 无残留。

## M4 —— 控制台 UI + 可观测性

1. 源列表 Lazy/Pinned/external 视觉强区分；Lazy 源有「缓存 ≠ 备份」固定提示；Pinned 显示固化数/上次校验时间/结果；仪表盘顶部列出未固化源。
2. 每源命中率、字节量、R2 操作数估算、月度成本估算可见。
3. 配置导出 JSON → 清空 D1 → 导入 → 源配置 diff 为空。

## M5 —— 冷热分层

1. 预置访问统计造数后，tier Workflow 把符合条件的对象迁入 cold 桶，`blobs.tier` 更新，hot 侧无残留。
2. 冷对象访问正常服务（206/200 正确）；访问频率回升的对象被回热。
3. 仪表盘显示分层前后的月度存储成本估算差。
