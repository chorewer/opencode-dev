# 工程规范

本文档涵盖我们在这个仓库中编写、测试、记录和交付代码的方式。全文以 [openclaw](https://github.com/openclaw/openclaw) 作为参考实现，所有示例均直接来自该代码库。

---

## 目录

1. [模块设计](#1-模块设计)
2. [类型系统](#2-类型系统)
3. [测试](#3-测试)
4. [文档](#4-文档)
5. [Git 协作流](#5-git-协作流)
6. [CI/CD](#6-cicd)
7. [Agent 开发与沙箱](#7-agent-开发与沙箱)

---

## 1. 模块设计

### 原则：功能不外出

每个模块拥有自己的数据结构、逻辑和副作用。它不深入其他模块的内部，其他模块也不深入它——只有公共接口（从 `index.ts` 导出的部分）是契约。

**"模块"的定义：** 具有单一职责的目录——`extensions/feishu/`、`packages/feishu-bitable/`、`src/tool/` 等。边界在文件系统层面，而不仅仅是类或文件。

### 具体结构

```
extensions/feishu/
├── index.ts          ← 只有公共接口，没有任何逻辑
├── package.json      ← 声明依赖和 openclaw 插件元数据
└── src/
    ├── types.ts      ← 模块内所有共享类型，从 schema 派生
    ├── config-schema.ts  ← zod schema；types.ts 从这里导入推断类型
    ├── client.ts     ← Lark.Client 工厂，带缓存，无业务逻辑
    ├── accounts.ts   ← 凭据解析，纯函数
    ├── policy.ts     ← 白名单/群组策略，纯函数，零 I/O
    ├── send.ts       ← 所有发往飞书的 API 调用，单文件负责
    ├── bitable.ts    ← Bitable 工具注册，自包含
    ├── policy.test.ts
    ├── send.test.ts
    └── bitable.test.ts
```

`index.ts` 只做重新导出，不包含任何逻辑：

```ts
// extensions/feishu/index.ts
export { monitorFeishuProvider } from "./src/monitor.js"
export { sendMessageFeishu, sendCardFeishu } from "./src/send.js"
export { feishuPlugin } from "./src/channel.js"

const plugin = { ... register(api) { ... } }
export default plugin
```

**规则：** 如果你发现自己在写 `import ... from "../../othermodule/internals"`，说明边界划错了。要么把共享内容移到公共包，要么重新考虑归属关系。

### 一个函数做一件事，除非可复用

不要为了给中间步骤命名而拆分函数。只有当提取出来的部分在多处使用，或者需要单独测试时，才拆分。

```ts
// 好——一个函数，流程清晰
async function cmdGetMeta(args: string[]) {
  const url = args[0]
  if (!url) fail("Usage: get-meta <url>")
  const parsed = parseBitableUrl(url!)
  if (!parsed) fail("Invalid URL")
  const appToken = parsed.isWiki ? await appTokenFromWiki(c, parsed.token) : parsed.token
  const res = await c.bitable.app.get({ path: { app_token: appToken } })
  ensure(res, "bitable.app.get")
  out({ app_token: appToken, ... })
}
```

### 最小化跨模块依赖

`extensions/feishu/src/policy.ts` 是一个好例子：它只依赖 `./types.js` 和 `./targets.js`。不从核心 gateway 导入任何东西，不从 agent 层导入，不从任何其他 channel 导入。你可以直接 import 它来测试，不需要任何前置设置。

```ts
// policy.ts — 零 I/O，无外部服务依赖
export function resolveFeishuAllowlistMatch(params: {
  allowFrom: Array<string | number>
  senderId: string
  senderIds?: Array<string | null | undefined>
  senderName?: string | null
}): FeishuAllowlistMatch { ... }
```

所有策略、解析、转换逻辑都应该是这个形状的目标。

---

## 2. 类型系统

### 严格使用 TypeScript，依赖类型推断

类型不是文档——是约束。目标是在编译时捕获错误，而不是给每个变量加注释。

```ts
// 好——推断；只在导出或必要时才显式标注
const accounts = listEnabledFeishuAccounts(cfg)
const appToken = parsed.isWiki ? await appTokenFromWiki(c, parsed.token) : parsed.token

// 差——多余的标注
const accounts: ResolvedFeishuAccount[] = listEnabledFeishuAccounts(cfg)
const appToken: string = parsed.isWiki ? ...
```

### 从 schema 派生类型，而不是反过来

先定义 schema（zod），再从它派生 TypeScript 类型。永远不要手写一个和 schema 重复的类型。

```ts
// config-schema.ts — schema 是唯一真相来源
const FeishuDomainSchema = z.union([z.enum(["feishu", "lark"]), z.string().url().startsWith("https://")])

// types.ts — 类型是派生的，不是手写的
export type FeishuDomain = z.infer<typeof FeishuDomainSchema>
// 结果: "feishu" | "lark" | (string & {})
```

这个模式意味着运行时验证（zod）和静态类型始终保持同步。改了 schema，类型自动更新。

### 把模块所有类型集中在一个文件

每个模块都有一个 `types.ts`，导出该模块的所有共享类型。内部文件从 `./types.js` 导入，而不是互相导入。这能防止循环依赖，也让重构更直接。

```ts
// types.ts — feishu 模块所有类型集中在这里
export type ResolvedFeishuAccount = { ... }
export type FeishuMessageContext = { ... }
export type FeishuSendResult = { ... }
export type FeishuProbeResult = BaseProbeResult<string> & { ... }
```

### 避免 `any`；必要时用带注释的显式 cast

当 Lark SDK 需要无类型的 `fields` 对象时，显式 cast 并注明原因：

```ts
// bitable.ts
const res = await client.bitable.appTableRecord.create({
  path: { app_token: appToken, table_id: tableId },
  data: { fields: fields as any }, // SDK 类型过宽；运行时验证在 API 侧
})
```

带注释的显式 cast 可以接受。从推断中隐式产生的 `any` 不行。

### Lint 和格式化不可绕过

`oxlint --type-aware` 在每次 commit 时（pre-commit hook）和 CI 中都会运行。`oxfmt` 强制统一格式。没有手动步骤——hook 会自动修复 lint 和格式，然后重新暂存文件：

```bash
# git-hooks/pre-commit
if [ "${#lint_files[@]}" -gt 0 ]; then
  "$RUN_NODE_TOOL" oxlint --type-aware --fix -- "${lint_files[@]}"
fi
if [ "${#format_files[@]}" -gt 0 ]; then
  "$RUN_NODE_TOOL" oxfmt --write -- "${format_files[@]}"
fi
git add -- "${files[@]}"
```

---

## 3. 测试

### 核心哲学：测真实行为，不测 mock

默认立场是测试实际实现。Mock 引入了一个会偏移的第二实现。每个 mock 都是一个赌注——赌 mock 正确地表达了被替换事物的行为——而这个赌注经常输。

**只在以下情况才 mock：**

- 副作用不可逆或代价高昂（外部 API 调用、生产路径的文件系统写入、数据库变更）
- 副作用具有不确定性，导致测试本身没有意义（系统时钟、随机数）
- 依赖太慢，让测试套件无法使用

即便如此，在信任使用了 mock 的测试之前，要先验证 mock 确实正确地表达了真实行为。

### 纯函数：零 mock

`streaming-card.test.ts` 是标准示例。`mergeStreamingText` 没有 I/O，没有副作用，没有依赖，直接测：

```ts
// streaming-card.test.ts — 18 行，无 mock，无 setup
import { describe, expect, it } from "vitest"
import { mergeStreamingText } from "./streaming-card.js"

describe("mergeStreamingText", () => {
  it("当新文本已包含旧文本时，优先使用新文本", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world")
  })
  it("不注入换行符地拼接分片", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world")
  })
})
```

`policy.test.ts` 是同样的模式。整个白名单和群组策略逻辑——包括安全关键的显示名伪造攻击场景——都通过直接调用函数来测试：

```ts
it("不允许通过显示名碰撞授权", () => {
  const victimOpenId = "ou_4f4ec5aa111122223333444455556666"
  expect(
    resolveFeishuAllowlistMatch({
      allowFrom: [victimOpenId],
      senderId: "ou_attacker_real_open_id",
      senderIds: ["on_attacker_user_id"],
      senderName: victimOpenId, // 攻击者把显示名设成受害者的 ID
    }),
  ).toEqual({ allowed: false })
})
```

不需要 mock，不需要 setup。函数是确定性的——相同输入，相同输出。

### 集成边界：mock 传输层，不 mock 逻辑

当一个函数编排 I/O 时（例如 `handleFeishuMessage`，它分发消息、调用 API、路由到 agent），你 mock 传输层——真正发出网络请求的函数——但保留路由和编排逻辑为真实代码。

```ts
// bot.test.ts — mock 网络调用，测试编排逻辑
const { mockCreateFeishuReplyDispatcher, mockSendMessageFeishu } = vi.hoisted(() => ({
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
    dispatcher: vi.fn(),
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
  mockSendMessageFeishu: vi.fn().mockResolvedValue({ messageId: "pairing-msg", chatId: "oc-dm" }),
}))

vi.mock("./reply-dispatcher.js", () => ({ createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher }))
vi.mock("./send.js", () => ({ sendMessageFeishu: mockSendMessageFeishu }))
```

测试随后执行真实的 `handleFeishuMessage` 代码路径，只有出站调用被替换。被测试的逻辑——消息解析、路由决策、策略检查、session key 计算——都真实运行。

### 用 `vi.importActual` 保留真实实现，只替换需要的部分

```ts
vi.mock("./bot.js", async () => {
  const actual = await vi.importActual<typeof import("./bot.js")>("./bot.js")
  return {
    ...actual, // 所有真实导出保留
    handleFeishuMessage: handleFeishuMessageMock, // 只替换这一个
  }
})
```

### 共享 mock 工厂

所有 extension 测试使用 `extensions/test-utils/` 里的 `createPluginRuntimeMock`。这是一个深度合并工厂：只传入需要覆盖的方法，其他一切都得到 `vi.fn()` stub：

```ts
setFeishuRuntime(
  createPluginRuntimeMock({
    channel: {
      debounce: { createInboundDebouncer, resolveInboundDebounceMs },
    },
  }),
)
```

这防止每个测试文件各自维护一套不完整的、会偏移的 runtime stub。

### 测试文件紧邻源文件

测试文件和它们测试的文件放在同一目录，使用 `.test.ts` 后缀：

```
src/foo/bar.ts
src/foo/bar.test.ts          ← 同目录

extensions/feishu/src/policy.ts
extensions/feishu/src/policy.test.ts
```

`test/` 目录只放跨系统测试：E2E harness、发布检查、共享工具函数和 fixtures。

### 测试分层与运行时机

| 层级      | 文件模式                  | 命令                   | 运行时机                    |
| --------- | ------------------------- | ---------------------- | --------------------------- |
| 单元      | `*.test.ts`               | `bun test`             | 每次 commit，默认           |
| Extension | `extensions/**/*.test.ts` | `bun test:extensions`  | 按需；修改 extension 时运行 |
| E2E       | `*.e2e.test.ts`           | `bun test:e2e`         | 合并前；真实子进程          |
| Live      | `*.live.test.ts`          | `LIVE=1 bun test:live` | 按需；需要真实 API key      |

CI 在每个 PR 上运行单元 + extension + E2E。Live 测试永远不要求在 CI 中通过。

### 测什么，不测什么

**要测：**

- 所有纯函数（解析、策略、转换、格式化）
- 路由和编排逻辑（传输层 mock 掉）
- 安全关键路径（白名单、权限检查、输入清理）
- 核心逻辑的边界情况和错误处理
- 任何曾经出过 bug 的函数

**不要单元测试：**

- 内容只是调用外部 API 的函数（改用 live/集成测试）
- 接线代码和入口（CLI 参数解析、`main()`、插件注册顺序）
- UI 渲染（由手动测试/E2E 覆盖）
- 完全被类型系统覆盖的内容

**什么时候写测试：**

测试和代码在同一个 PR 里。不要在没有测试的情况下合并逻辑——除非明确是接线文件（入口点、注册、配置透传）。修复 bug 时，先写一个本应能捕获它的回归测试，再修代码。

### 覆盖率阈值

行/函数/语句 70%，分支 55%。只针对 `./src/**/*.ts`——集成密集的表面（gateway、channel 桥接、CLI 接线）被明确排除，因为它们由 E2E 和手动测试验证，而不是靠覆盖率数字。

---

## 4. 文档

### 两类文档，分开维护

**代码旁边的文档** 解释单个文件或模块。它们放在代码旁边，在同一个 PR 中更新：

- 每个包/extension 目录中的 `AGENTS.md`——在该范围内工作的 AI agent 和人类的操作手册
- 内联注释，用于记录非显而易见的决策（不是说代码做了什么，而是为什么这样做）
- 只有当包被发布或有非显而易见的设置时，才在包里放 `README.md`

**项目级文档** 解释概念、架构、配置和运维。放在 `docs/` 中，按主题组织：

```
docs/
├── concepts/     ← agent-loop、session、memory、streaming——系统如何工作
├── channels/     ← 每个 channel 一个文件（feishu.md、slack.md……）
├── gateway/      ← 部署、配置、安全
├── design/       ← RFC、设计提案、研究笔记
└── reference/    ← 测试命令速查、发布检查清单、内部约定
```

### AGENTS.md 是一等制品

每个包和重要目录都有一个 `AGENTS.md`。它是人类和 AI agent 在该范围内工作的操作手册，内容包括：

- 这个包做什么
- 如何构建和测试
- 该区域特有的约定和陷阱
- 不应该做什么

创建新包时，同时创建 `AGENTS.md`。`CLAUDE.md` 是 `AGENTS.md` 的符号链接——两个都创建。

### 文档和代码在同一个 PR 里

添加新 channel 时，在同一个 PR 里加 `docs/channels/yourchannel.md`。改变 session key 的工作方式时，在同一个 PR 里更新 `docs/concepts/session.md`。与其描述的代码分开发布的文档，是立即过时的文档。

### 设计文档和 RFC

提案和设计文档放在 `docs/design/`。实现后不需要删除——它们记录了决策的原因。保持与最终实现的准确性，如果提案在实现过程中有修改，在顶部加一个简短说明。

---

## 5. Git 协作流

### 分支命名

```
feat/description     ← 新功能
fix/description      ← bug 修复
refactor/description ← 重构，无行为变化
docs/description     ← 仅文档
chore/description    ← 工具、依赖、CI
```

默认分支是 `dev`。`main` 保留给发布（或者本地可能不存在——用 `origin/dev` 做 diff）。

### Commit 风格

每个 commit 一个逻辑变更。commit message 描述**为什么**，不是**做了什么**：

```
# 好
fix: 修复两个 bot 共享同一个群时的 session key 碰撞问题

# 差
update bot.ts
```

diff 已经展示了改了什么。commit message 解释意图。

### PR 要求

- 每个 PR 都有描述，解释问题和方案
- 新逻辑的测试在同一个 PR 里——不是后续跟进
- 文档更新在同一个 PR 里
- AI 辅助的 PR 欢迎；标注 `ai-assisted` 标签
- 保持 PR 聚焦；避免混入无关变更

### 合并方式

将功能分支 squash-merge 到 `dev`。这保持 `dev` 历史可读——每个功能一个 commit，有有意义的 message。merge commit 保留用于将发布分支合回。

### 密钥和凭据

永远不要 commit 密钥。pre-commit hook 对每个暂存文件运行 `detect-secrets`。如果测试 fixture 中出现凭据，使用明显的假值（如 `test_app_id_for_unit_tests`）。`.secrets.baseline` 跟踪已知的误报。

---

## 6. CI/CD

### CI 在每个 PR 和每次推送到 `dev` 时运行

CI 流水线（`ci.yml`）有多个层级，设计上让便宜的检查先跑，无关的昂贵检查被跳过：

```
docs-scope          ← 检测是否只有文档变更
    ↓（如果只有文档，跳过所有重量级 job）
changed-scope       ← 检测哪些区域被触及（node/macos/android/windows）
    ↓
build-artifacts     ← 构建一次 dist，在 job 间共享
    ↓
checks（矩阵）:
  - node: pnpm test
  - node: protocol:check
  - bun: vitest run --config vitest.unit.config.ts
    ↓
check:
  - pnpm check（类型 + lint + 格式）
  - build:strict-smoke
  - lint:ui:no-raw-window-open
    ↓
release-check       ← 验证 npm pack 内容（仅 push 到 main 时）
```

**纯文档变更完全跳过 test、build、Windows、macOS 和 Android job。** 这让文档 PR 的 CI 保持快速。

**PR job 用 changed-scope 跳过无关平台。** 只触及 `extensions/feishu/` 的变更不会触发 macOS 或 Android 构建。

### 合并前必须通过

```bash
pnpm check    # 类型 + lint + 格式
pnpm build    # dist 构建干净
pnpm test     # 单元 + extension 测试通过
```

如果 `pnpm test` 在负载高的机器上抖动，重跑一次。如果第二次还抖动，就是真正的失败。

### Docker 发布

`docker-release.yml` 构建多架构镜像（amd64 + arm64），在每次推送到 `main` 和版本 tag 时推送到 GHCR。文档类变更不触发：

```yaml
paths-ignore:
  - "docs/**"
  - "**/*.md"
  - ".agents/**"
  - "skills/**"
```

版本 tag（`v*`）产生带版本号的镜像 tag 并更新 `:latest`。推送到 `main` 产生 `:main-amd64` / `:main-arm64`。

### 安装冒烟测试

`install-smoke.yml` 构建根目录 Dockerfile，在容器内运行 `openclaw --version`。每个 PR 都跑，在打包回归到达用户之前就捕获。

### Pre-commit Hooks

pre-commit hook 只对暂存文件运行，速度很快：

```bash
# git-hooks/pre-commit
lint_files=(...)   # 只有暂存的 TS/JS 文件
format_files=(...)

oxlint --type-aware --fix -- "${lint_files[@]}"
oxfmt --write -- "${format_files[@]}"
git add -- "${files[@]}"   # 重新暂存修复后的文件
```

这意味着 CI 里几乎看不到 lint 或格式失败——在 commit 落地之前就在本地修好了。

安全检查也在 pre-commit 时运行：`detect-secrets`、`shellcheck`、`actionlint`，以及 `zizmor`（GitHub Actions 安全审计）。

### CI 中的环境和密钥

真实 API key 永远不在仓库里。需要 key 的 CI job 使用 GitHub Actions secrets。需要真实 key 的测试放在 `*.live.test.ts` 文件中，除非设置了 `LIVE=1` 否则跳过。Live 测试永远不在 PR CI 中运行——只在手动触发或定时运行时。

---

## 7. Agent 开发与沙箱

### Agent 在隔离的 session 中运行

每个 agent session 由 `sessionKey` 标识，它编码了 channel、账号和对端身份：

```
agent:<agentId>:feishu:group:<chatId>
agent:<agentId>:feishu:direct:<senderOpenId>
```

两个 agent、两个账号、两个 chat，产生不同的 session key。上下文永远不会在不同 key 的 session 之间泄漏。这是最基本的隔离原语。

### Agent 默认没有发消息的能力

在 openclaw 中注册的 agent 不能向任意目标发消息。唯一的输出路径是通过 `dispatcher.deliver`，它绑定到触发本次 session 的特定 chat。Agent 可以产生文本；channel 层决定如何发送、发送到哪里。

这是刻意的设计。如果 agent 可以用任意 target 调用 `send_message` 工具，一个 session 中的 prompt injection 就能把数据泄漏到另一个 session。通过将所有输出路由到 session dispatcher，被攻陷的 session 的爆炸半径被限制在该 session 的目标 chat 范围内。

### Agent 工具访问数据，不操作通信渠道

注册给 openclaw agent 的工具都是数据工具：文档读写、wiki、云盘、bitable CRUD。没有一个向用户发消息。区别在于：

- **数据工具**：agent 可以读写结构化数据（bitable、wiki、文档）
- **通信**：完全由 channel 层控制，不由 agent 控制

构建新的 agent 工具时，保持这种分离。读取外部服务的工具没问题。向用户或其他系统发消息的工具是另一类别，需要明确的理由。

### 沙箱化 agent 的工作环境

Agent 进程不继承完整的宿主环境。测试基础设施使用临时 HOME，清除所有真实 token：

```ts
// test/test-env.ts
export async function installTempHome() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"))
  process.env.HOME = tmpDir
  // 清除所有 token/key 环境变量，防止测试意外使用真实凭据
}
```

在生产环境中，agent 在容器中运行，有明确的能力授予。`Dockerfile.sandbox` 定义了所需的最小能力集。不要推测性地添加能力——授予需要的，不多授。

### 多 Agent 安全

当多个 agent 实例在同一进程中运行时（例如向观察者 agent 广播），它们共享同一个 session 存储。规则是：**读操作始终安全；永远不允许向另一个 agent 的 session 写入。**

如果 agent A 需要把上下文传给 agent B，通过消息 channel 来做（B 收到一条消息，创建自己的 session），永远不要直接写入 B 的 session 状态。

### AGENTS.md 是 agent 的操作手册

每个 AI agent 可能工作的目录都有一个 `AGENTS.md`，告诉 agent：

- 应该运行和不应该运行哪些命令
- 可以安全修改什么
- 存在哪些陷阱
- 如何验证自己的工作

当你为 agent 辅助开发设置代码库的新区域时，先写 `AGENTS.md`。这迫使你明确说清楚哪些不变量是重要的，也让在该区域的自动化工作更安全、更可预测。
