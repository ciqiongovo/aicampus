# im-connector · 微信 / QQ 聊天记录接入原型

知枢的「聊天记录 → 信息理解」模块，独立可跑，不依赖 Electron、不改知枢任何现有文件。
跑通后按本文末尾「接入知枢」把文件搬进 `src/` 即可。

```
聊天记录源 ──► 适配器 ──► im_message / im_session ──► 切窗 ──► 抽取 ──► im_insight ──► 日报 / 检索
  QQ 导出 txt       qqExport          (SQLite + FTS5)      segment   heuristic|llm
  微信 chatlog      chatlog
```

## 快速开始

不需要 `npm install`：TypeScript 和 `@types/node` 复用知枢的 `node_modules`（Node ≥ 22，`node:sqlite` 内置）。

```bash
cd 知枢/tools/im-connector
npm run build                  # node ../../node_modules/typescript/bin/tsc -p tsconfig.json
npm test                       # 6 个测试文件，51 项断言，全部用内存库

node dist/cli.js demo          # 一键演示：导入示例导出文件 → 规则理解 → 生成两天的摘要
node dist/cli.js doctor        # 体检：数据库 / FTS5 / 微信目录 / QQ 目录 / chatlog / 模型
```

`demo` 会在 `demo/out/` 下写出 `digest-YYYY-MM-DD.md`。

## 两种数据来源

| 来源 | 状态 | 做法 |
|---|---|---|
| QQ 消息管理器导出 txt | ✅ 可用 | QQ → 消息管理器 → 选中会话 → 导出为 txt，然后 `import-qq` |
| 微信 4.x（本机 4.1.15） | ✅ 适配完成，需侧车 | 运行 [chatlog](https://github.com/sjzar/chatlog) `chatlog server --addr 127.0.0.1:5030`，再 `sync` |
| 微信 3.x | 未适配 | 可换 PyWxDump / WeChatMsg 导出，或让 chatlog 处理 |
| QQ NT 本地库直读 | ❌ 不做 | `nt_msg.db` 是 SQLCipher，`node:sqlite` 打不开；社区解密工具不稳定 |

> 采集放在独立进程（侧车）里，主进程只通过 loopback HTTP + token 读明文结果。
> 这样 Electron 侧不碰解密逻辑，也不违反「主进程不直接读别人数据库」的边界。

## CLI

```bash
node dist/cli.js doctor [--json]
node dist/cli.js import-qq <导出文件...> [--title 群名] [--enable|--disable]
node dist/cli.js sync [--url http://127.0.0.1:5030] [--token T] [--all]   # 微信，走 chatlog
node dist/cli.js sessions [--json]
node dist/cli.js status <会话ID|标题>
node dist/cli.js enable|disable <会话ID|标题>
node dist/cli.js understand <会话ID|标题> [--provider auto|llm|heuristic] [--force] [--all]
node dist/cli.js insights [--session 1] [--kind todo|decision|fact|link|question|topic] [--day 2026-10-16] [--json]
node dist/cli.js digest [YYYY-MM-DD]        # 默认今天，写到 demo/out
node dist/cli.js search <关键词> [--session 1] [--limit 20]
node dist/cli.js llm-check                  # 只发一条最小请求，验证 Key/端点
node dist/cli.js channels                   # 打印本模块的 IPC 通道，接入时对照
node dist/cli.js demo [--file 导出文件]
```

会话参数既可以是数字 ID，也可以是标题片段（多命中会列出候选并要求更精确）。

## 目录

```
src/shared/im.ts               IPC 通道常量 + 全部共享类型（接入时整体复制）
src/shared/imTime.ts           本地时间工具（YYYY-MM-DD HH:mm:ss，避免 UTC 偏移）
src/main/db/imSchema.ts        迁移：version 16「im-chat-source」，只建表
src/main/db/dao/imDao.ts       全部 SQL；FTS 在运行时 ensureImFts 建，失败自动降级 LIKE
src/main/services/im/
  types.ts                     ImSourceAdapter 契约（listSessions / fetchMessages）
  qqExport.ts                  QQ 导出 txt 解析 + 适配器（幂等 id = qq-<sha1>）
  chatlog.ts                   chatlog HTTP 客户端 + 适配器
  normalize.ts                 微信 XML/appmsg/引用/撤回清洗
  segment.ts                   按时间间隔 + 条数 + 字数切窗
  heuristic.ts                 规则抽取（无模型兜底）
  llm.ts                       OpenAI 兼容 chat/completions，60s 超时，JSON mode
  understand.ts                提示词、JSON 校验、证据回填、落库
  ingest.ts                    同步编排（会话 → 消息 → 游标）
  service.ts                   ImService：给 IPC 和 CLI 共用的门面
src/main/ipc/im.ts             registerImIpc(ipcMain, service)，不 import electron
src/cli.ts                     命令行入口
demo/qq-export-sample.txt      17 条消息的示例导出（含决定/待办/链接/图片/文件）
tests/*.test.cjs               6 个测试文件
```

## 表结构

| 表 | 关键点 |
|---|---|
| `im_account` | `UNIQUE(platform, account_key)`；state / last_error / last_sync_at |
| `im_session` | `UNIQUE(account_id, platform_session_id)`；`enabled` 控制是否理解；`last_seq` 增量游标；`summary` + `summary_seq` 滚动摘要 |
| `im_message` | `UNIQUE(session_id, platform_msg_id)` 保证重复导入幂等；`deleted` 软删；保留 `raw` 原文便于回溯 |
| `im_window` | 一次理解覆盖的消息区间 `[start_seq, end_seq]`，`UNIQUE(session_id,start_seq,end_seq)` 保证不重复花钱 |
| `im_insight` | kind + title + detail + due_at + assignee + url + confidence + `evidence`(消息 id 数组) + status |
| `im_message_fts` | FTS5 虚表，`tokenize='trigram'`；中文必须用 trigram，默认 unicode61 会把整句当一个 token |

`im_message` 上的触发器可选；本模块在 DAO 里显式维护 FTS（`bulkUpsertMessages` 内同步写/删），
比触发器更好控制「删除后移出检索」，也方便在 FTS5 不可用时整体降级。

检索策略：`ensureImFts` 成功且查询 ≥3 字 → FTS5 短语查询；否则 `LIKE %q% ESCAPE`。

## 理解管线

1. **清洗**（`normalize.ts`）：微信的 `<msg><appmsg>`、`<refermsg>` 引用、`revokemsg` 撤回、`sysmsg` 系统消息统一成 `kind + text + quoteText + deleted`。
2. **切窗**（`segment.ts`）：连续消息间隔 > 30 分钟、或累计 > 80 条、或 > 4000 字就断开；窗口起点对齐到「回复链」的第一条。
3. **抽取**（`understand.ts`）：
   - 固定 JSON：`topic / summary / decisions / todos / facts / links / questions / urgency / confidence`；
   - 每条结论必须带 `evidence: number[]`，只能是本窗口真实存在的消息 id，越界的直接丢弃；
   - 解析失败重试一次，再失败回退规则抽取，不会让整场同步失败。
4. **落库**：先删该窗口旧结论再写新的（`--force` 重跑费用可控），窗口记录避免重复理解。
5. **汇总**：`digest(day)` 按会话、按 kind 渲染 Markdown；同一天多次运行结果稳定。

规则抽取（`heuristic.ts`）不是玩具：没有模型 Key 时它保证待办、决定、链接、待确认问题四类仍有产出，
同时在测试里充当确定性基准。关键词用 2~3 字 n-gram + 停用词 + 子串去重，避免「日报 / 进日报 / 进日」这类碎片同时出现。

## 接入知枢

只新增文件，不改现有逻辑；下面每一步都能独立回退。

1. **迁移**：把 `src/main/db/imSchema.ts` 的 `imMigrations` 追加到 `src/main/db/migrations.ts` 的 `MIGRATIONS`（version 16）。迁移只建表，FTS 由 `ensureImFts` 运行时创建，老库升级不会因为 FTS5 缺失而失败。
2. **DAO / 服务**：`src/main/db/dao/imDao.ts`、`src/main/services/im/*` 原样复制。
3. **IPC**：`src/shared/im.ts` 复制进 `src/shared/`；在 `src/main/ipc/index.ts` 的 `registerIpc` 里加一行 `registerImIpc(ipcMain, new ImService({ db, complete }))`。
4. **preload**：在 `src/preload/index.ts` 的白名单里加 `IM_IPC` 的 13 个通道，渲染进程通过 `window.api.im*` 调用。
5. **理解服务复用**：`ImService` 的 `complete` 直接传 `src/main/services/ai/analyzer.ts` 的 `chatCompletion` 包装，使用应用内已配置的 AI，不必再存一份 Key。
6. **ID 对齐**：`im_insight` 的 `evidence` 是本地消息 id，落 `info` 表时把 `source_type` 设成 `'im'`、`source_id` 填 `im_insight.id`，`syncAnalysisToInfo` 的幂等键照此扩展即可。
7. **JARVIS 工具**：给 Agent 加 `chat.search` / `chat.context` 两个只读工具（分别包 `service.search`、`listMessages`），回答里带 `[会话名 2026-10-16 09:03](#im:12345)` 形式的引用。
8. **日报**：`digest` 的结果直接作为「聊天摘要」区块拼进日报；待办类结论走现有的「转事项」通道。

## 环境变量

| 变量 | 用途 |
|---|---|
| `IM_DB_PATH` | CLI 用的数据库路径，默认 `:memory:`（只影响 CLI） |
| `IM_WECHAT_DIR` | 微信数据根目录，默认自动找 `D:\WeChat Files` 等 |
| `IM_QQ_DIR` | QQ 数据根目录，默认自动找 `Documents\Tencent Files` |
| `IM_CHATLOG_URL` / `IM_CHATLOG_TOKEN` | chatlog 侧车地址与 token（默认 `http://127.0.0.1:5030`） |
| `IM_LLM_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` | 模型 Key，三者取第一个存在的 |
| `IM_LLM_BASE_URL` / `IM_LLM_MODEL` | 端点与模型，默认 `https://api.deepseek.com` + `deepseek-chat` |
| `IM_DIGEST_DIR` | 摘要输出目录，默认 `demo/out` |

## 合规与安全

- 微信 / QQ 用户协议不允许第三方客户端读取本地数据，个人自用有账号风险；企业场景应走企业微信「会话内容存档」的官方接口。
- 群聊包含第三方个人信息：默认只理解用户手动启用的会话（`enabled`），原文保留在本地库，不自动上传；接模型时只发切窗后的文本，不发 `raw`、图片和文件路径。
- 结论必须能回溯到消息 id（`evidence`），避免模型编造；`confidence < 0.6` 的结论建议只进「待确认」，不直接进日报待办。
- 上线前补：数据加密（SQLCipher / 系统凭据）、保留期限与一键清除、导出与删除的审计记录。

## 测试

```
tests/normalize.test.cjs   13 项  微信 XML / appmsg / 引用 / 撤回 / 系统消息
tests/db.test.cjs          11 项  迁移幂等、upsert、分页、FTS trigram 与 LIKE 回退、结论状态
tests/segment.test.cjs      7 项  间隔/条数/字数切窗与回复链对齐
tests/qq.test.cjs           8 项  导出格式解析、稳定 id、幂等
tests/chatlog.test.cjs      6 项  用 node:http 桩验证健康检查、会话列表、增量拉取、鉴权头
tests/e2e.test.cjs          6 项  导入 → 理解 → 摘要 → 检索 → 开关 → 增量跳过
```

`npm test` 会先 `tsc` 再逐个跑测试；每个测试文件都自建 `:memory:` 库，互不影响。

## 已知限制

- QQ 只能走「消息管理器导出」，拿不到实时增量；要实时得先解决 SQLCipher。
- 微信依赖 chatlog 的版本适配，微信升级后可能需要等 chatlog 跟进。
- 规则抽取的召回有限（只覆盖四类），语义质量依赖模型；`heuristic` 的 `confidence` 固定 0.42，低于默认的日报门槛。
- 没做图片 OCR、语音转写、文件内容解析，只记 `[图片]` / `[文件]` 占位和路径。
- 中文检索依赖 FTS5 trigram（SQLite ≥ 3.34 编译时带 FTS5）；不满足时全量退化为 LIKE。
