# Node.js 后端移植计划（Fastify + TypeScript）

版本目标：`1.5.3-node`｜ 状态：进行中｜ 参照实现：[`backend-java/`](../backend-java/)（Spring Boot）与 [`backend/`](../backend/)（FastAPI，行为基准）

## 1. 目标与非目标

**目标**

- 第三个后端实现，与 Python / Java 后端**共享同一套 `/api/v1` 契约**，前端 `frontend/` 与桌面壳 `desktop/` 零改动即可切换。
- 直接复用 Java 版已经解决的移植决策（JSON 字段名、NaN 处理、圈速边界规则、赛道匹配算法），而不是重新从 Python 反推——Java 后端是最接近目标形态的参照物。
- 同一台机器上三个后端可并行启动做逐端点对拍（Python 8012 / Java 8011 / Node 8010）。

**非目标**

- 不重新设计 API、不改前端调用方式、不引入新的数据格式。
- 不做安装包（与 Java 版一致：后端 + 前端分别运行即可，桌面安装器已由用户明确降级）。
- 不追求 60 Hz 与排位赛的逐位数值一致（Java 版已知遗留项，Node 版同样按 10 Hz / 3D 主用例校验）。

## 2. 规模与来源

| 实现 | 语言 | 规模 |
|---|---|---|
| `backend/` | Python / FastAPI | 5,382 行，28 个路由端点 |
| `backend-java/` | Java 21 / Spring Boot 4.1.1 | 69 个源文件、7,275 行，32 个端点方法 |
| `backend-node/` | TypeScript / Fastify 5 | 移植中，与 Java 版逐模块对应 |

移植源以 **Java 代码为主**（分层清晰、契约已定），Python 仅在两处回查：`numpy`/`pandas` 语义细节（如 `arange` 舍入）、以及 Java 注释未说明的行为动机。

## 3. 技术选型与 Java 对等物

| 关注点 | Java 版 | Node 版 | 理由 |
|---|---|---|---|
| HTTP 框架 | Spring MVC `@RestController` | Fastify 5 plugin + `routes` | 路由即插件，前缀 `/api/v1` 由 `register(..., { prefix })` 提供 |
| DTO + 校验 | record + Bean Validation | `zod` schema + `infer` 类型 | 校验挂在 `preValidation`，错误映射成 FastAPI 的 `{"detail": ...}` |
| 依赖注入 | Spring 容器构造器注入 | 手工 `context.ts` 组装单例 | 后端只有 ~20 个协作者，容器不值得 |
| 配置 | `@ConfigurationProperties("lmu")` + `application.yml` | `config/env.ts` 读同名环境变量 | 保持 `SERVER_PORT` / `APP_DATA_DIR` / `LMU_*` 一致，Electron 无需改动 |
| 静态资源 | `WebConfig` resource handler + `IndexController` | `@fastify/static` + SPA fallback | 同路径语义：`/api/v1/profile-data/**`、`/assets/**`、`/steering wheel/**` |
| 数据库 | `duckdb_jdbc 1.5.6.0` | `@duckdb/node-api 1.5.6-r.2` | **同为 DuckDB 1.5.6**，SQL 与列类型行为可直接对齐 |
| 流式查询 | `ResultSet` 逐行 | `connection.streamAndReadAll(sql)` → `DuckDBResultReader` | 遥测大结果集必须流式，与 Java 的 `TelemetryJsonWriter` 对应 |
| Discord | 手写 HTTP 客户端（459 行，直连 Discord REST） | `discord.js 14` | 用户已选定；省掉手写分页/上传/错误重试 |
| 本地文件选择 | Swing `JFileChooser`（JVM 自带 GUI） | Electron `dialog.showOpenDialog` | Node 无原生 GUI：见 §6 的桥接方案 |
| 缓存 | Caffeine | `Map` + mtime 失效 | 仅两处缓存（sessions/laps 的 mtime、avatar），无需三方库 |
| 并发模型 | Tomcat 线程池 | Node 单线程事件循环 | 见 §5 数值密集的 fusion 段处理 |
| 测试 | JUnit 5 | `vitest` | 与 Java 同名用例逐一对应 |
| 打包 | `jpackage` app-image | `esbuild` bundle + Node 运行时 | 见 §7 |

## 4. 分层与目录映射

保持与 Java 版**同名同序**的四层，便于三边对照：

```
backend-node/src/
├── server.ts                 # LmuTelemetryApplication
├── app.ts                    # Fastify 实例装配（CORS/静态/错误处理/路由注册）
├── context.ts                # 组合根：显式构造并连接 infra → application → api
├── config/env.ts             # AppProperties
├── api/                      # 14 个 Controller → 14 个 route 插件
│   ├── error.ts              # ApiException + 全局 handler（FastAPI 错误形状）
│   ├── dto.ts                # DiscordDtos / ProfileDtos / SessionDtos / SystemDtos
│   └── telemetryWriter.ts    # TelemetryJsonWriter（NaN → null 的流式 JSON）
├── application/              # 11 个 Service
├── domain/                   # 12 个 record/class → interface + 工厂函数
└── infra/
    ├── fs/      duckdb/   fusion/   track/   car/   discord/   system/
```

命名约定：

- 文件名 kebab-case，导出符号 PascalCase（类）或 camelCase（函数），与 Java 类名一一对应：`infra/fusion/fusion-engine.ts` ↔ `FusionEngine.java`。
- **JSON 字段名以 Java 的 record 组件名 + `@JsonProperty` 最终输出为准**（混合 camelCase / snake_case，例如 `Profile.created_at` 与 `SessionInfo.trackName`）；`undefined` 字段的省略规则按 `@JsonInclude` 逐类还原：`Profile`/`SessionInfo` 省略 null，`SessionMetadata` 始终输出。
- 相对 import 必须带 `.js` 后缀（`moduleResolution: NodeNext`）。
- 错误路径：所有业务异常抛 `ApiException(status, message)`，由全局 handler 转 `{"detail": message}`；未知异常统一 500 `"Internal Server Error"`，不外泄堆栈。

## 5. 数值与并发要点

- `Channel` 用 `Float64Array` 承载（Java 用 `double[]`），`NaN` 语义一致；`FusedFrame.channels` 必须是**插入有序**的映射 → 用 `Map<string, Channel>`（JS Map 保证插入序，等价 `LinkedHashMap`）。
- 融合引擎是纯 CPU 热路径：先在主线程同步实现（与 Java 行为一致），若 60 Hz 大 session 阻塞事件循环明显，再把整次融合放进 `worker_threads`（接口不变，只在 `TelemetryService` 一层切换）。
- DuckDB 查询全部 async；同一文件的连接不共享，按请求打开/关闭，避免跨请求状态。

## 6. 三个需要偏离 Java 实现的地方

1. **文件选择对话框**：`POST /system/pick-and-upload` 在 Java 里用 Swing 直接弹窗。Node 侧没有 GUI，改为
   - 主路径（Electron）：前端已有的 `importPaths()` → `POST /system/import-paths`，弹框由 `desktop/main.js` 的 `dialog.showOpenDialog` 承担；
   - 兼容路径：`pick-and-upload` 保留端点，无 Electron 环境时返回 400 `"Native file picker is unavailable in headless mode"`（与 Java 的 headless 分支同文案）。
2. **Discord 分享/下载**：改用 `discord.js`。必须保持对外 JSON 与 Java 完全一致（`/discord/config`、`/discord/shares`、`/discord/shares/download`、`/sessions/{id}/discord/share`），tag 匹配、成员校验、forum 多文件上传、头像解析、`discord__` 前缀下载命名逐条对照 `DiscordService.java`。凭据仍走 `discord_config.json`（格式不变，含 `template` 文件）。
3. **进程内状态缓存**：Java 用 Caffeine 与实例字段缓存 sessions/laps；Node 保持同样的进程内 `Map`，并在实现里显式写出失效条件（mtime + size），不引入新缓存框架。

## 7. 运行与打包

- 端口沿用约定：**开发 8001**（Vite 代理已指向此端口，`frontend/vite.config.ts` 无需改）、**生产 8000**（Electron 期望值）。
- 环境变量与 Java 版同名：`SERVER_PORT`、`APP_DATA_DIR`、`LMU_DEV_MODE`、`LMU_TELEMETRY_DIR`、`LMU_FRONTEND_DIR`、`LMU_STEERING_WHEEL_DIR`、`LMU_LOG_FILE`。
- 开发：`npm run dev`（`tsx watch`）；类型检查：`npm run typecheck`；测试：`npm test`。
- 生产：`npm run build` → `esbuild` 打成单文件 bundle + 原生 DuckDB `.node` 二进制随包，`desktop/main.js` 用 `spawn(process.execPath, [bundle])` 启动。Electron 自身已带 Node 运行时，因此不需要额外分发运行时。

## 8. 阶段划分

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 脚手架：Fastify 实例、env 配置、日志、错误形状、CORS、domain 类型 | `/api/v1/health`、`/api/v1/ping`、`/api/v1/debug/env` 与 Java 输出一致 |
| P1 | `infra/fs` + `application/{Profile,Session,System}Service` + 对应路由 | profiles/sessions/system 全端点可用；`PathSafety` 越权用例通过 |
| P2 | `infra/{duckdb,track,car}` + `application/{Lap,ReferenceLap}Service` | `/sessions` 最佳圈选择规则、`/laps` 边界与 sectors 对齐 |
| P3 | `infra/fusion` + `TelemetryService` + 流式 writer | 合成 fixture 下通道集与行数一致，值差 ≤ 1e-6 |
| P4 | `Track3DService` | baseMap / racingLine / sectors / center / zBase 结构与数值对齐 |
| P5 | `SetupService`、`LapExportService`、`SvmExporter`、`infra/discord` | setup JSON 嵌套结构一致；SVM 文本一致；Discord 四端点契约一致 |
| P6 | 静态托管、SPA fallback、profile-data 挂载 | 与 Java 的 web 模式清单逐条相同 |
| P7 | 打包、Electron 联调、文档 | `npm run build` 产物可被 Electron 拉起并完成导入→分析 |

## 9. Parity 校验策略

Java 版依赖 `tools/parity/*.py` 与 `testdata/duckdb/` 两个仓库里目前**不存在**的资产（仅在提交说明中被引用）。因此 Node 版采用三层自证，不依赖缺失文件：

1. **单元测试对齐**：把 Java 的 6 个测试类逐一移植（`PathSafety`、`TrackMatcher`、`CarCatalog`、`FusionEngine`、`SvmExporter`、`TelemetryJsonWriter`），用同名输入断言同名输出。
2. **合成 fixture 自建**：用 `@duckdb/node-api` 在测试里生成一个与 Python 生成器同构的最小多 stint 数据库，替代缺失的 `generate_synthetic_duckdb.py`，使 fusion/lap 测试无需外部数据即可运行。
3. **活体对拍（用户侧）**：给出脚本，让用户在同一台机器上并起 Python 8012 / Java 8011 / Node 8010 三个后端，逐端点比对响应结构与数值容差。这是唯一能覆盖真实 session 的手段。

## 10. 已知风险

- DuckDB Node 绑定是原生模块，Electron 打包需按 Electron 的 Node ABI 重编译或直接用系统 Node 起子进程（当前选择：子进程，避开 ABI 矩阵）。
- `discord.js` 需要 bot token 且走 gateway 语义与 Java 的纯 REST 调用不同，若真实分享行为出现偏差，回退方案是照抄 `DiscordClient.java` 的 REST 调用。
- 事件循环阻塞（§5）在大 session 60 Hz 融合时可能拖慢并发请求。
- Python 语义遗留：`numpy.arange` 毫秒舍入造成的 60 Hz 差异会原样继承，不在本版修复。
