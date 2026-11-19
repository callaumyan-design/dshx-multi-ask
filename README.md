# dshx-multi-ask — 多模型同问

一个问题**同时**发给多个不同的 AI，所有回答并排、同时流式输出，方便对比参考。

## 在主输入框里同时选多个模型（1.1）

主输入框底部，**模型选择器左边**多了一个「**+ 同问**」按钮：

1. 点它，勾选想同时问的模型（可以多选、可搜索）。勾上第一个后，这个会话的「发送时同问」会自动打开，按钮变成「同问 N」。
2. 之后在主输入框正常发消息：主模型照常回答；同一句话**同时**发给勾选的模型，它们的回答自动在右侧「多模型同问」面板里并排流式显示（问题前标 `↗ 主对话`）。
3. 这些模型能看到和主模型相同的对话记录（主对话的纯文本转录），但不能用工具；它们的回答不会写回主对话。
4. 取消「发送时同问」或「清空」即停止；开关按会话记忆，模型勾选全局共享（与面板顶部的勾选是同一份）。

实现：宿主监听 `agent/inbox/inserted`，只把 `source.kind === 'user'` 的提示复制进该会话的同问队列；浏览器只对打开了开关的会话（最多 3 个）长轮询 `GET /dshx-multi-ask/feed`。没人监听的会话不会记录任何内容。

## 面板用法

| 入口 | 说明 |
|---|---|
| `Ctrl+Shift+M`（mac `⌘⇧M`） | 打开 / 聚焦本会话的多模型面板 |
| 输入框 `/multi 问题` | 打开面板并把问题发给所有已选模型；问题**不会**发给主模型 |
| 右侧栏 `+` → 「多模型同问」卡片 | 打开面板 |
| 会话标题（面包屑）右键 | 「多模型同问」 |

面板里：

1. 左上角「模型 (N) ▾」展开模型列表，可搜索，勾选任意多个（所有已配置的 provider 的模型都会列出）。选择会被记住。
2. 输入问题，Enter 发送（Shift+Enter 换行）。每个模型一张卡片，**同时**开始流式回答；卡片头的圆点表示状态（蓝 = 正在回答，绿 = 完成，红 = 出错）。
3. 追问：每个模型接着**自己**之前的回答继续（模型 A 看不到模型 B 的回答）。
4. 单张卡片可「停止」/「重试」/「展开」/「复制」；底部「全部停止」或 Esc 停止所有。
5. 勾选「带上主对话」：把当前主对话的记录（用户/助手文字、工具调用摘要和截断后的工具结果，不含系统提示）作为背景附在第一个问题前。
6. 右侧栏拖宽后，回答卡片会自动排成多列（每列最小 300px）。

问答记录只存在浏览器 `localStorage`（`dshx-multi-ask.v1.rounds.<sessionId>`，每个会话最多 30 轮），**不写入主对话**。

## 机制

- 浏览器对每个已选模型并行发一个 `POST /dshx-multi-ask/ask`，宿主端用 `ctx.llm.stream()` 直接调用对应 provider/model，NDJSON 流式回传。一个模型失败不影响其他模型。
- 请求不带工具、不带 `sessionId`，所以任何 provider 都能接受，也不会和主对话正在进行的请求冲突。
- 主会话日志零写入。

## 配置（`cordis.patch.yml` 的 `dshx-multi-ask` 条目 `config:`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxTurns` | 20 | 每个模型追问时带上的之前问答轮数 |
| `maxContextChars` | 60000 | 「带上主对话」最多附带的字符数（保留最新部分） |
| `maxOutputTokens` | 0 | 每个回答输出上限，0 = 模型默认 |
| `requestTimeoutSeconds` | 600 | 单个模型请求超时 |

## 路由

- `POST /dshx-multi-ask/ask` `{ provider, model, question, history?, sessionId?, withContext? }` → NDJSON `meta / thinking / text / done / error`
- `GET /dshx-multi-ask/models`
- `GET /dshx-multi-ask/pending?sessionId=`（取走 `/multi` 排队的问题）
- `GET /dshx-multi-ask/feed?sessionId=&waitMs=`（长轮询，取走主输入框发出的问题；最长 25s）

## 安装 / 更新

退出 DSH 后：`node install-profile.mjs`（`--dry-run` 预览）。三处登记（node_modules 副本、package.json 依赖+bundles、profile `cordis.patch.yml` 显式条目）一次做完，带备份与 BOM 检查。
回滚：从 profile `package.json` 的 `bundles` 删掉 `dshx-multi-ask`，或还原 `*.bak-multi-ask-*`。

## 测试

```
cd test
node host-test.mjs     # 42 项：历史/上下文组装、/multi 排队、两个模型并发流式、单模型出错隔离、模型列表、主会话零写入、apply 注册
node client-test.mjs   # 22 项：tab 类型/槽位、/multi、Ctrl+Shift+M、标题右键、面板渲染、每模型独立线程、存储恢复
```
`test/node_modules` 是从本机 `app.asar` 抽出的真 `@deepseek-ai/dsh-llm`（0.2.2-rc.1），可用 `extract-host.cjs` 重抽。

## Model Experience

### 多模型提问请求

#### What the Model Sees

每个被选中的模型各收到一个独立请求：该模型自己之前的问答 + 新问题，无系统提示、无工具。勾选「带上主对话」时，第一个问题前有一段 `<conversation>…</conversation>` 纯文本主对话记录（见 `index.js` 的 `framedQuestion`）。

#### Token Impact

N 个模型 = N 倍请求。每个请求输入 ≈ 该模型线程 + （可选）主对话记录（上限 `maxContextChars`）。主对话本身 token 不变。

#### KV Cache Impact

每个模型的请求彼此独立；同一模型的追问在前缀上是追加式的，可命中提供方前缀缓存。主对话的缓存前缀不受影响。

## Known Limitations

- 多模型面板里的模型**不能用工具**，只能基于问题（和可选的主对话记录）作答。
- 记录只在本浏览器，换浏览器/清缓存即丢失。
- 图片/文件附件不会发给各模型（主对话记录里只以 `[图片]`/`[文件]` 占位）。
- 宿主升级后要复查：`sidebarRightTabs.register` / `openTabFromTarget` / `shortcuts.register` 形状、`ctx.llm.stream` / `listModels`、`command/executed` 客户端事件。
