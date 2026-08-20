# doco-memory-dsh

把 Doco 在线知识库变成 DeepSeek Harness (dsh) 的**集中式 Agent 记忆**：跨设备、跨会话，每个用户自己的记忆库。

> 本插件是三层架构的第二层（运行时），依赖 [doco-dsh](https://github.com/songofhawk/doco-dsh)（≥0.2.0）提供的 `doco` 服务。布局规范见 [Doco Memory Layout spec v1](https://github.com/songofhawk/doco-memory-dsh/blob/main/design/doco-memory-layout-spec-v1.md)（harness 无关，其他工具链可用 MCP + skill 实现）。

## 它解决什么

- Agent 会话之间忘事：换设备/换会话后，上次的结论、决策、调试教训找不回。
- 「集中」的含义：**你自己的** Doco 账号里有一个记忆库，跨设备、跨会话可见；不是所有人共用一个库。
- 插件不写死任何知识库/文件夹/文档 id：存哪里由你运行时的 `init` 决定，manifest 是唯一权威。

## 安装

```bash
npm install doco-memory-dsh
```

在 dsh 插件配置中，把 doco-memory-dsh 与 doco-dsh 一起挂载（顺序无关，但 doco-dsh 必须先完成自身初始化以提供 `doco` 服务）：

```yaml
# dsh.yaml / profile
plugins:
  - id: doco-dsh
  - id: doco-memory-dsh
```

## 快速开始

1. `doco connect`（doco-dsh）完成身份授权；
2. 运行：**`/doco memory init`** —— 新建知识库「Agent Memory」（或接管你指定的库），创建标准目录结构（`_meta/`、`inbox/`、`profile/`、`facts/`、`episodes/`、`runbooks/`、`archive/`）并写入 manifest；
3. 之后 Agent 会自动：

   - 开场用 `doco_memory_context` 拉取当前项目上下文包（用户画像 + 近期经验）；
   - 需要事实/历史决策时用 `doco_memory_recall` 检索（自动限定当前项目 + global 范围）；
   - 值得长期保留的结论用 `doco_memory_remember` 沉淀（写前查重、preview 先行、确认后 commit）。

## 工具

| 工具 | 说明 | 写？ |
| --- | --- | --- |
| `doco_memory_init` | 初始化记忆库（新建/接管/repair），建结构 + 写 manifest | 是（需确认） |
| `doco_memory_recall` | 检索记忆，默认 `global` + 当前项目范围，带引用返回 | 否 |
| `doco_memory_context` | 当前项目上下文包（profile + 近期 episodes），token 预算内 | 否 |
| `doco_memory_remember` | 沉淀一条记忆：写前查重 → preview → commit；支持 `promote` 升级 | 是（需确认） |

## 配置（环境变量 / profile options）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOCO_MEMORY_KB` | （取 doco-dsh `defaultKb`） | 记忆库 id（缺省 init 时新建或自动解析） |
| `DOCO_MEMORY_KB_NAME` | `Agent Memory` | 新建知识库的名称 |
| `DOCO_MEMORY_RECALL_LIMIT` | `12` | recall 默认返回条数（1–50） |
| `DOCO_MEMORY_CONTEXT_BUDGET` | `2000` | context 包 token 预算（64–50000） |
| `DOCO_MEMORY_ALLOW_WRITES` | `false` | 记忆写入总开关（默认只读；需配合 scope `documents:write`） |

## 设计要点（对应 Layout 规范）

- **D2 自描述**：manifest（`_meta/manifest`，schema `doco-memory/1`）是布局唯一权威，本地只缓存 doc_id；写回带 If-Match，409 重读合并，永不整篇覆盖。
- **D6 审阅队列**：`inbox/审阅队列` 是 living doc，未经人工勾选完成（taskItem）的条目视为未定稿。
- **D7 写前查重**：`remember` 先 recall，命中既有块建议更新而非新建碎片；冲突不自动合并，进审阅队列。
- **D8′ 可逆授权 Agent、不可逆保留人类**：本版只提供 `remember`（新增/修订），`forget`（不可逆）属 P2，且仅人类命令触发。
- **D15 遗忘自主但归档**：P2 的归档型遗忘（蒸馏→归档、每轮上限、pin 保护、遗忘报告）。
- **D16 使用频次服务端记**：客户端只留 `_meta/usage` 引用瘦台账（块级引用计数，加法合并，冲突安全），服务端统计为 S1 立项。
- **D17 promote 双触发**：`remember(..., promote=true)` 支持升级 global facts。
- 记忆条目统一前缀 `[<YYYY-MM-DD> | <scope> | <source>] <正文>`，不符合格式的块视为人类手写，自动归档绝不碰。

## 开发

```bash
npm install          # 会 link 本地 ../doco-dsh（devDependency）
npm test             # 单元 + 工具 + 真实 dsh-tools 冒烟
```

测试无需真实 Doco 账号：fake context / fake doco 服务替身模拟 dsh 运行时与后端契约。

## 许可证

MIT