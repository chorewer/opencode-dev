# Engineering Guide

This document covers how we build, test, document, and ship code in this repo. It uses [openclaw](https://github.com/openclaw/openclaw) as a reference implementation throughout — concrete examples are drawn directly from that codebase.

---

## Table of Contents

1. [Module Design](#1-module-design)
2. [Type System](#2-type-system)
3. [Testing](#3-testing)
4. [Documentation](#4-documentation)
5. [Git Workflow](#5-git-workflow)
6. [CI/CD](#6-cicd)
7. [Agent Development and Sandboxing](#7-agent-development-and-sandboxing)

---

## 1. Module Design

### Principle: functionality does not leave its module

Every module owns its own data shapes, logic, and side effects. It does not reach into other modules' internals, and other modules do not reach into it — only the public interface (exported from `index.ts`) is contract.

**What "module" means here:** a directory with a single responsibility — `extensions/feishu/`, `packages/feishu-bitable/`, `src/tool/`, etc. The boundary is the filesystem, not just a class or file.

### Concrete structure

```
extensions/feishu/
├── index.ts          ← public interface only; no logic here
├── package.json      ← declares dependencies and openclaw plugin metadata
└── src/
    ├── types.ts      ← all shared types for this module; derived from schemas
    ├── config-schema.ts  ← zod schemas; types.ts imports inferred types from here
    ├── client.ts     ← Lark.Client factory; cached; no business logic
    ├── accounts.ts   ← credential resolution; pure functions
    ├── policy.ts     ← allowlist/group policy; pure functions, zero I/O
    ├── send.ts       ← all outbound Feishu API calls; single file owns this
    ├── bitable.ts    ← Bitable tool registrations; self-contained
    ├── policy.test.ts
    ├── send.test.ts
    └── bitable.test.ts
```

`index.ts` only re-exports; it contains no logic:

```ts
// extensions/feishu/index.ts
export { monitorFeishuProvider } from "./src/monitor.js"
export { sendMessageFeishu, sendCardFeishu } from "./src/send.js"
export { feishuPlugin } from "./src/channel.js"

const plugin = { ... register(api) { ... } }
export default plugin
```

**Rule:** if you find yourself importing `../../othermodule/internals`, the boundary is wrong. Either move the shared thing to a common package, or reconsider ownership.

### Keep things in one function unless composable or reusable

Do not split a function just for the sake of naming intermediate steps. Split only when the extracted piece is used in more than one place, or when it needs to be tested in isolation.

```ts
// Good — one function, clear flow
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

### Minimize cross-module dependencies

`extensions/feishu/src/policy.ts` is a good example: it depends only on `./types.js` and `./targets.js`. It imports nothing from the core gateway, nothing from the agent layer, nothing from any other channel. You can test it by importing it directly with no setup.

```ts
// policy.ts — zero I/O, no external service dependencies
export function resolveFeishuAllowlistMatch(params: {
  allowFrom: Array<string | number>
  senderId: string
  senderIds?: Array<string | null | undefined>
  senderName?: string | null
}): FeishuAllowlistMatch { ... }
```

This is the target shape for all policy, parsing, and transformation logic.

---

## 2. Type System

### Use TypeScript strictly; rely on inference

Types are not documentation — they are constraints. The goal is to catch mistakes at compile time, not to annotate every variable.

```ts
// Good — infer; only annotate exports or when necessary
const accounts = listEnabledFeishuAccounts(cfg)
const appToken = parsed.isWiki ? await appTokenFromWiki(c, parsed.token) : parsed.token

// Bad — redundant annotation
const accounts: ResolvedFeishuAccount[] = listEnabledFeishuAccounts(cfg)
const appToken: string = parsed.isWiki ? ...
```

### Derive types from schemas, not the other way around

Define your schema first (zod), then derive the TypeScript type from it. Never write a type that duplicates a schema.

```ts
// config-schema.ts — schema is the source of truth
const FeishuDomainSchema = z.union([z.enum(["feishu", "lark"]), z.string().url().startsWith("https://")])

// types.ts — type is derived, not hand-written
export type FeishuDomain = z.infer<typeof FeishuDomainSchema>
// result: "feishu" | "lark" | (string & {})
```

This pattern means your runtime validation (zod) and your static types are always in sync. If you change the schema, the types update automatically.

### Collect all module types in one file

Each module has a `types.ts` that exports all shared types for that module. Internal files import from `./types.js`, not from each other. This prevents circular dependencies and makes refactoring straightforward.

```ts
// types.ts — all types for the feishu module in one place
export type ResolvedFeishuAccount = { ... }
export type FeishuMessageContext = { ... }
export type FeishuSendResult = { ... }
export type FeishuProbeResult = BaseProbeResult<string> & { ... }
```

### Avoid `any`; use `unknown` with type guards or casts where necessary

When the Lark SDK requires an untyped `fields` object, cast explicitly and comment why:

```ts
// bitable.ts
const res = await client.bitable.appTableRecord.create({
  path: { app_token: appToken, table_id: tableId },
  data: { fields: fields as any }, // SDK type is too wide; runtime validation is on the API side
})
```

Explicit casts with a comment are acceptable. Implicit `any` from inference is not.

### Lint and format are non-negotiable

`oxlint --type-aware` runs on every commit (pre-commit hook) and in CI. `oxfmt` enforces formatting. There is no manual step — the hook fixes lint and format automatically then re-stages files:

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

## 3. Testing

### Philosophy: test real behavior, not mocks

The default posture is to test the actual implementation. Mocks introduce a second implementation that drifts. Every mock is a bet that the mock correctly captures the behavior of the thing being replaced — and that bet is often wrong.

**Test real code unless:**

- The side effect is irreversible or expensive (external API calls, filesystem writes in production paths, database mutations)
- The side effect is non-deterministic in a way that makes the test meaningless (wall clock, random)
- The dependency is so slow that it makes the suite unusable

Even then, verify that the mock correctly represents the real behavior before trusting tests that use it.

### Pure functions: zero mocks

`streaming-card.test.ts` is the canonical example. `mergeStreamingText` has no I/O, no side effects, no dependencies. Test it directly:

```ts
// streaming-card.test.ts — 18 lines, no mock, no setup
import { describe, expect, it } from "vitest"
import { mergeStreamingText } from "./streaming-card.js"

describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world")
  })
  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world")
  })
})
```

`policy.test.ts` is the same pattern. The entire allowlist and group policy logic — including security-critical cases like display-name spoofing — is tested by calling the function directly:

```ts
it("does not authorize based on display-name collision", () => {
  const victimOpenId = "ou_4f4ec5aa111122223333444455556666"
  expect(
    resolveFeishuAllowlistMatch({
      allowFrom: [victimOpenId],
      senderId: "ou_attacker_real_open_id",
      senderIds: ["on_attacker_user_id"],
      senderName: victimOpenId, // attacker sets display name to victim's ID
    }),
  ).toEqual({ allowed: false })
})
```

No mock needed. No setup needed. The function is deterministic — same input, same output.

### Integration boundaries: mock the transport, not the logic

When a function orchestrates I/O (e.g. `handleFeishuMessage` which dispatches messages, calls APIs, routes to agents), you mock the transport layer — the functions that actually make network calls — but you keep the routing and orchestration logic real.

```ts
// bot.test.ts — mock network calls, test orchestration logic
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

The test then exercises the real `handleFeishuMessage` code path, with only the outbound calls stubbed. The logic under test — message parsing, routing decisions, policy checks, session key computation — runs for real.

### Use `vi.importActual` to keep real implementations when only one piece needs mocking

```ts
vi.mock("./bot.js", async () => {
  const actual = await vi.importActual<typeof import("./bot.js")>("./bot.js")
  return {
    ...actual, // all real exports
    handleFeishuMessage: handleFeishuMessageMock, // only this one replaced
  }
})
```

### Shared mock factories for extension tests

All extension tests use `createPluginRuntimeMock` from `extensions/test-utils/`. This is a deep-merge factory: pass only the methods you need to override, everything else gets a `vi.fn()` stub:

```ts
setFeishuRuntime(
  createPluginRuntimeMock({
    channel: {
      debounce: { createInboundDebouncer, resolveInboundDebounceMs },
    },
  }),
)
```

This prevents test files from each maintaining their own incomplete runtime stubs that drift from the real interface.

### Colocate tests with source

Test files live next to the files they test, with the `.test.ts` suffix:

```
src/foo/bar.ts
src/foo/bar.test.ts        ← same directory

extensions/feishu/src/policy.ts
extensions/feishu/src/policy.test.ts
```

The `test/` directory is for cross-system tests only: E2E harnesses, release checks, shared helpers and fixtures.

### Test layers and when to run them

| Layer     | File pattern              | Command                | When it runs                         |
| --------- | ------------------------- | ---------------------- | ------------------------------------ |
| Unit      | `*.test.ts`               | `bun test`             | Every commit, default                |
| Extension | `extensions/**/*.test.ts` | `bun test:extensions`  | Opt-in; run when touching extensions |
| E2E       | `*.e2e.test.ts`           | `bun test:e2e`         | Pre-merge; real subprocesses         |
| Live      | `*.live.test.ts`          | `LIVE=1 bun test:live` | On demand; requires real API keys    |

CI runs unit + extension + E2E on every PR. Live tests are never required to pass in CI.

### What to test and what not to test

**Test:**

- All pure functions (parsing, policy, transformation, formatting)
- Routing and orchestration logic (with transport mocked)
- Security-critical paths (allowlists, permission checks, input sanitization)
- Edge cases and error handling in core logic
- Any function that has previously had a bug

**Do not unit-test:**

- Functions whose only content is calling an external API (test those with live/integration tests instead)
- Wiring and entrypoints (CLI argument parsing, `main()`, plugin registration order)
- UI rendering (covered by manual/E2E)
- Things that are entirely covered by the type system

**When to write tests:**
Write the test in the same PR as the code. Never merge logic without tests unless it is explicitly a wiring file (entrypoint, registration, config passthrough). If you fix a bug, write a regression test that would have caught it first.

### Coverage thresholds

70% lines/functions/statements, 55% branches. These apply only to `./src/**/*.ts` — integration-heavy surfaces (gateway, channel bridges, CLI wiring) are explicitly excluded because they are validated by E2E and manual testing, not unit coverage numbers.

---

## 4. Documentation

### Two kinds of documentation; keep them separate

**Code-adjacent docs** explain a single file or module. They live next to the code and are updated in the same PR:

- `AGENTS.md` in each package/extension directory — operating instructions for AI agents working in that scope
- Inline comments for non-obvious decisions (not for what the code does, but for why)
- `README.md` in a package only when the package is published or has a non-obvious setup

**Project-level docs** explain concepts, architecture, configuration, and operations. They live in `docs/` and are organized by topic:

```
docs/
├── concepts/     ← agent-loop, session, memory, streaming — how the system works
├── channels/     ← one file per channel (feishu.md, slack.md, ...)
├── gateway/      ← deployment, configuration, security
├── design/       ← RFCs, design proposals, research notes
└── reference/    ← test commands, release checklist, internal conventions
```

### AGENTS.md is a first-class artifact

Every package and significant directory has an `AGENTS.md`. It is the operating manual for both humans and AI agents working in that scope. It covers:

- What this package does
- How to build and test it
- Conventions and footguns specific to this area
- What not to do

When you create a new package, create `AGENTS.md` at the same time. `CLAUDE.md` is a symlink to `AGENTS.md` — create both.

### Documentation goes in the same PR as the code

If you add a new channel, add `docs/channels/yourchannel.md` in the same PR. If you change how session keys work, update `docs/concepts/session.md` in the same PR. Documentation that ships separately from the code it describes is documentation that is immediately out of date.

### docs/ is English only; translations are generated

The `docs/zh-CN/` and `docs/ja-JP/` directories are generated by a translation pipeline. Do not edit them by hand. Write only in `docs/` (English). The pipeline syncs translations after merge.

### Design documents and RFCs

Proposals and design documents go in `docs/design/`. They do not need to be deleted after implementation — they serve as a record of why a decision was made. Keep them accurate to the final implementation, and add a short note at the top if the proposal was modified during implementation.

---

## 5. Git Workflow

### Branch naming

```
feat/description     ← new feature
fix/description      ← bug fix
refactor/description ← refactor, no behavior change
docs/description     ← documentation only
chore/description    ← tooling, deps, CI
```

The default branch is `dev`. `main` is reserved for releases (or may not exist locally — use `origin/dev` for diffs).

### Commit style

One logical change per commit. The message describes _why_, not _what_:

```
# Good
fix session key collision when two bots share a group

# Bad
update bot.ts
```

The diff already shows what changed. The commit message explains the intent.

### Pull request expectations

- Every PR has a description that explains the problem and the approach
- Tests for new logic are in the same PR — not a follow-up
- Documentation updates are in the same PR
- AI-assisted PRs are welcome; label them with `ai-assisted`
- Keep PRs focused; avoid mixing unrelated changes

### Merging

Squash-merge feature branches into `dev`. This keeps `dev` history readable — one commit per feature, with a meaningful message. Reserve merge commits for integrating release branches back.

### Secrets and credentials

Never commit secrets. The pre-commit hook runs `detect-secrets` on every staged file. If a credential appears in a test fixture, use a clearly fake value (e.g. `test_app_id_for_unit_tests`). The `.secrets.baseline` tracks known false positives.

---

## 6. CI/CD

### CI runs on every PR and every push to `dev`

The CI pipeline (`ci.yml`) has several layers, designed so that cheap checks run first and expensive checks are skipped when irrelevant:

```
docs-scope          ← detect if this is a docs-only change
    ↓ (skip heavy jobs if docs-only)
changed-scope       ← detect which areas are touched (node/macos/android/windows)
    ↓
build-artifacts     ← build dist once, share across jobs
    ↓
checks (matrix):
  - node: pnpm test
  - node: protocol:check
  - bun: vitest run --config vitest.unit.config.ts
    ↓
check:
  - pnpm check (types + lint + format)
  - build:strict-smoke
  - lint:ui:no-raw-window-open
    ↓
release-check       ← verify npm pack contents (push to main only)
```

**Docs-only changes skip test, build, Windows, macOS, and Android jobs entirely.** This keeps CI fast for documentation PRs.

**PR jobs use changed-scope to skip unrelated platforms.** A change that only touches `extensions/feishu/` does not trigger macOS or Android builds.

### What must pass before merge

```bash
pnpm check    # types + lint + format
pnpm build    # dist builds cleanly
pnpm test     # unit + extension tests pass
```

If `pnpm test` flakes on a loaded machine, rerun once. If it flakes a second time, it is a real failure.

### Docker release

`docker-release.yml` builds multi-arch images (amd64 + arm64) and pushes to GHCR on every push to `main` and on version tags. It does not run on docs-only changes:

```yaml
paths-ignore:
  - "docs/**"
  - "**/*.md"
  - ".agents/**"
  - "skills/**"
```

Version tags (`v*`) produce versioned image tags and update `:latest`. Pushes to `main` produce `:main-amd64` / `:main-arm64`.

### Install smoke

`install-smoke.yml` builds the root Dockerfile and runs `openclaw --version` inside it. This runs on every PR to catch packaging regressions before they reach users.

### Pre-commit hooks

The pre-commit hook runs on staged files only, making it fast:

```bash
# git-hooks/pre-commit
lint_files=(...)   # only staged TS/JS files
format_files=(...)

oxlint --type-aware --fix -- "${lint_files[@]}"
oxfmt --write -- "${format_files[@]}"
git add -- "${files[@]}"   # re-stage fixed files
```

This means you almost never see lint or format failures in CI — they are fixed locally before the commit lands.

Security checks also run pre-commit: `detect-secrets`, `shellcheck`, `actionlint`, and `zizmor` (GitHub Actions security audit).

### Environment and secrets in CI

Real API keys are never in the repo. CI jobs that require them use GitHub Actions secrets. Tests that require real keys are in `*.live.test.ts` files and are skipped unless `LIVE=1` is set. Live tests never run in PR CI — only manually or on scheduled runs.

---

## 7. Agent Development and Sandboxing

### Agents operate in isolated sessions

Each agent session is identified by a `sessionKey` that encodes channel, account, and peer identity:

```
agent:<agentId>:feishu:group:<chatId>
agent:<agentId>:feishu:direct:<senderOpenId>
```

Two agents, or two accounts, or two chats, produce different session keys. Context never leaks between sessions with different keys. This is the fundamental isolation primitive.

### Agents have no send-message capability by default

Agents registered in openclaw cannot send arbitrary messages to arbitrary targets. The only output path is through `dispatcher.deliver`, which is bound to the specific chat that triggered the session. The agent can produce text; the channel layer decides how and where to send it.

This is intentional. If an agent could call a `send_message` tool with an arbitrary target, a prompt injection in one session could exfiltrate data to another. By routing all output through the session dispatcher, the blast radius of a compromised session is limited to that session's target chat.

### Agent tools access data, not communication channels

The tools registered to agents in openclaw are all data tools: document read/write, wiki, drive, bitable CRUD. None of them send messages to users. The distinction is:

- **Data tools**: agent can read and write structured data (bitable, wiki, docs)
- **Communication**: exclusively controlled by the channel layer, not the agent

When building new tools for agents, keep this separation. A tool that reads from an external service is fine. A tool that sends a message to a user or another system is a different category and needs explicit justification.

### Sandbox the agent's working environment

Agent processes do not inherit the full host environment. The test infrastructure uses a temp HOME with all real tokens cleared:

```ts
// test/test-env.ts
export async function installTempHome() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"))
  process.env.HOME = tmpDir
  // clear all token/key env vars so tests cannot accidentally use real credentials
}
```

In production, agents run in containers with explicit capability grants. The `Dockerfile.sandbox` defines the minimal set of capabilities needed. Do not add capabilities speculatively — grant what is needed, nothing more.

### Multi-agent safety

When multiple agent instances run in the same process (e.g. broadcasting to observer agents), they share the same session store. The rule is: **reads are always safe; writes to another agent's session are never allowed.**

If agent A needs to pass context to agent B, it does so through the message channel (B receives a message and creates its own session), never by directly writing to B's session state.

### AGENTS.md is the agent's operating manual

Every directory that an AI agent might work in has an `AGENTS.md` that tells the agent:

- What commands to run and not run
- What is safe to modify
- What footguns exist
- How to verify its work

When you set up a new area of the codebase for agent-assisted development, write the `AGENTS.md` first. It forces you to be explicit about the invariants that matter, and it makes automated work in that area safer and more predictable.
