# AGENTS.md —— 给后续维护者的入口

> 人类请读 [README](./README.md)；提交规则见 [CONTRIBUTING](./CONTRIBUTING.md)。
> 这份只回答两件事：**你在改哪一块、以及忘了哪一条会静默出错。**

---

## 零、先读这条：不要重启 magpie

`127.0.0.1:3425` 这个网关就是 `magpie-windows-amd64` 进程本身。停它一次，
所有模型请求立刻全断（DSH、agent 会话、正在跑的对话全部中断）。

改完怎么生效：
1. 改代码 → node --test 全绿
2. git commit + 打 tag + git push（github:Practice019/magpie-codar）
3. 用户在 magpie 界面点「更新」→ 热加载，不重启

永远不要：Stop-Process / Start-Process 任何 magpie*、
手改 plugins/node_modules/**、手改 plugin-providers.json（运行中进程会覆盖它）。

验证下发内容用字节数，不要用 .Length（那是字符数，中文 3 字节/字）。

### 发现 magpie 重启了，先别怪人

它自己会升级：`settings.json` 的 `updateEvery`（默认 360 分钟）到点就去 GitHub
看新版，下载成 `magpie-windows-amd64.exe.new`，替换后重启自己。升级日志会写：

```
%LOCALAPPDATA%\magpie\logs\app.log
  magpie <版本> started (app, pid …)
  update: … .exe.new goes on without its GitHub build attestation checked
```

判断顺序：
1. 先看 `app.log` 里有没有 `update:` 与新的 `started` 行 —— 有 = 自更新，与本项目无关
2. 再看版本号有没有变（升级前 0.1.4501 → 升级后 0.1.4624）
3. 两者都不成立，才怀疑有人手工重启

**要关掉自动升级**：在 magpie 设置界面改（不要手改 `settings.json` —— 运行中的进程会覆盖它）：
把「自动检查更新」关掉，或把 `updateEvery` 设为 0。

---

## 一、目录地图

| 路径 | 负责什么 |
|---|---|
| `index.mjs` | 插件入口，**只导出一个** `CodarPlugin`（`index.mjs:304`）：`config` / `auth.*` / `provider.models` |
| `lib/internal.mjs` | 厂商协议读取器与 `testables`（登录、签到、积分、模型字段都在这里；入口不导出它们） |
| `lib/serve.mjs` | 对话桥：起/复用本机 `codar.exe serve`，一轮一条 HTTP；直连网关会被拒（见坑 2） |
| `lib/native.mjs` | 目录/签到/积分的 **Go sidecar 传输**（`native/cmd/codar-proxy`），Windows 走 loopback 端口 + 0600 ready 文件 |
| `lib/guarded.mjs` | 没有代理时的兜底 fetch，带「不跨 origin 重定向」护栏（见坑 5） |
| `lib/catalog.mjs` | 静态模型表 —— **生成物**，由 `scripts/catalog.mjs` 写（见坑 6） |
| `lib/signinpage.mjs` | 「科搭OAuth登录」页面（短信+滑块、微信扫码、IP 校验） |
| `lib/chat-bridge.mjs` / `lib/client-body.mjs` / `lib/client-system*.mjs` / `lib/models-from-serve.mjs` | 请求体构造、客户端形态、serve 侧模型表 |
| `native/` | Go 代理（`cmd/codar-proxy`）+ `bin/` 下的预编译二进制 |
| `scripts/` | `catalog.mjs` / `tarball.mjs` / `build-native.mjs` / `extract-client-system.mjs` / `native-packages.mjs` |
| `test/` | `node --test` 的用例（含 `plugin.test.mjs`、`native.test.mjs`、`serve.test.mjs`） |

本插件**没有面板服务**（没有 `server.mjs`、没有 `page/`），也没有 `auth.options`。

## 二、改哪块该读什么

| 你在改 | 先读 | 做完的判据 |
|---|---|---|
| 登录 / 凭证 | `lib/signinpage.mjs`、`lib/internal.mjs`（`signInResult` 附近） | `node --test test/plugin.test.mjs` 绿；过期判定用 token 自己的 `exp` |
| 对话怎么发出去 | `lib/serve.mjs`、`lib/chat-bridge.mjs` | `test/serve.test.mjs` + `test/chat-bridge.test.mjs` 绿 |
| 指纹 / 传输层 | `lib/native.mjs`、`native/cmd/codar-proxy/main.go` | `npm run native:test`（Go）+ `test/native.test.mjs` 绿 |
| 模型目录 | `scripts/catalog.mjs`（源）、`lib/catalog.mjs`（生成物） | `npm run catalog:check` 退出 0 |
| 额度 / 签到 | `index.mjs` 的 `usage` / `checkin` 两段 | `node --test test/plugin.test.mjs` 绿 |
| 打包 / 发布 | `scripts/tarball.mjs`、`scripts/build-native.mjs` | `npm run test:tarball` 绿；`prepublishOnly` 三连能过 |

## 三、会静默出错的坑（症状 → 判据 → 出处）

| # | 症状 | 判据 | 出处 |
|---|---|---|---|
| 1 | OpenCode 1.x 直接拒绝整个包 | 入口模块**每个具名导出都会被当成插件**；辅助对象/工具函数必须放 `lib/`，`index.mjs` 只导出 `CodarPlugin` | `index.mjs:304`、`CONTRIBUTING.md`「The entry module exports only plugin functions」、`test/plugin.test.mjs` |
| 2 | 直连 `api.claw.speedai.com` 一律 403 | `403 client_not_supported`（"restricted to Codar"）：对话必须走本机 `codar.exe serve`，不能自己拼 HTTP | `lib/serve.mjs:1-15` |
| 3 | 第 4 个并发请求 429 | 厂商并发就是 **3**（实测 `concurrent_limit_exceeded`）；`maxConcurrency` getter 读目录里的数，没有就用 3 | `index.mjs:347-349` |
| 4 | 号是好的，但目录/签到/积分请求被判非客户端 | 桌面端走 Go sidecar，TLS/HTTP2/UA 指纹与 Node 的 fetch 不同 ⇒ 这三类请求走 `lib/native.mjs`；**二进制缺失时会回落成普通 fetch（指纹退回旧的）**，README 已写明 | `lib/native.mjs:1-17`、`lib/native.mjs:117`、`native/cmd/codar-proxy` |
| 5 | 凭据被发到了别的 host | 普通 fetch 默认跟随重定向且**带着 Authorization**（合成 sink 实测收到过）；兜底路径必须用 `guardedFetch`：跨 origin 不跟随、最多 5 跳 | `lib/guarded.mjs:1-21`、`lib/guarded.mjs:43` |
| 6 | 手改 `lib/catalog.mjs` 后下次生成就没了 | 静态表由 `scripts/catalog.mjs` 写出；要改源文件再生成，并用 `npm run catalog:check` 校验 | `lib/catalog.mjs:1-10`、`CONTRIBUTING.md:66-72`、`package.json` 的 `catalog:check` |
| 7 | 发布了但装着跑不起来 | `prepublishOnly` 三连：`build-native --check --strict` → `tarball --require-bun --require-builds` → `native-packages --check`；少一步就会发出缺二进制的 tarball | `package.json` 的 `prepublishOnly` |
| 8 | 额度卡片把路由搞乱 | `aside` 窗口**不能带 models**：宿主看到 models 就会拿它参与路由 | `index.mjs:1070-1071`、`index.mjs:1502-1503` |
| 9 | 对话 403 `client_not_supported` / 列表为空 | 对话**只能**走 `lib/serve.mjs` 的 `codar.exe serve`（桥接：`messages` 压成一条 `{"message":…}`）；模型名来自 `GET /api/desktop/settings`（回落 `/api/health`），叠加在 `lib/catalog.mjs` 上 | `lib/serve.mjs:1-20`、`lib/chat-bridge.mjs:1-12`、`lib/models-from-serve.mjs:1-16`、`index.mjs:152`、`index.mjs:1672` |
| 10 | 签到「明明成功却显示未签」/ 反之 | 签到靠**业务码 + 措辞**判：`already_claimed` 不是失败；深层包装（`{code:200,data:{data:{code:500}}}`）要往里读；否定词优先于成功词 | `index.mjs:695` 起的 `checkin` 段 |
| 11 | 续期后账号掉登录 | 续期**只能**在 `exp` 之前做（`refreshLead` 12 小时）；过期 token 厂商回 401，此时只能重登；失败消息必须过 `scrub` | `index.mjs:631-663` |

## 四、测试入口

- JS：`npm test`（= `node --test`）。需要上游响应的用例自己注入 transport，不打真实网络。
- Go：`npm run native:test`（= `cd native && go test ./...`）。
- 打包：`npm run test:tarball`（= `node scripts/tarball.mjs`）。
- 目录：`npm run catalog:check`（生成物与源不一致会失败）。
- 真机验证只在必要时做、限 1~3 次（直连 403、并发 429 都是这样量出来的）。

## 五、交付前自检（四条，每条都有会失败的判据）

| # | 检查 | 命令 / 判据 |
|---|---|---|
| 1 | 入口仍只导出插件函数 | `node --test test/plugin.test.mjs` |
| 2 | 目录静态表与源一致 | `npm run catalog:check` 退出 0 |
| 3 | Go 代理与 JS 侧协议一致 | `npm run native:test` |
| 4 | tarball 里文件齐全、能装 | `npm run test:tarball` |

另外两条不是命令而是纪律：**任何时候都不能把 token 打出来**（错误信息必须过
`scrubLine`，读响应必须经 `readAnswer` 的字节上限，见 `CONTRIBUTING.md`）；
`CHANGELOG.md` 里写的是版本号与可验的改动，不是“优化了一下”这种话。
