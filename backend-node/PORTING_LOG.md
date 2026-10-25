# Node.js 后端移植过程记录

配套计划见 [`../NODEJS_BACKEND_REWRITE_PLAN.md`](../NODEJS_BACKEND_REWRITE_PLAN.md)。本文件按时间顺序记录**实际做出的决策、与 Java 实现的偏差、以及踩到的坑**，供后续维护者和第三个后端的移植者参考。

移植源以 `backend-java/` 为准（69 个 Java 文件），Python `backend/` 作为行为基准。

---

## P0 — 脚手架与工具链

### 选型落定

- DuckDB 版本刻意对齐：Java 用 `duckdb_jdbc 1.5.6.0`，Node 选 `@duckdb/node-api 1.5.6-r.2`（同一个 DuckDB 内核版本，SQL 与列类型行为可直接照搬）。仓库 npm registry 为 `registry.npmmirror.com`，该版本可取。
- Fastify 5.12.7 + `@fastify/cors` + `@fastify/multipart`；校验用 `zod`；Discord 用 `discord.js 14.27`。
- `@fastify/static` 装过又移除了：静态托管最终按 Java 的 `IndexController` / `FrontendResourceController` 显式写成路由（要精确复现 Java 对 URL 编码路径、`/steering wheel/**`、越权检查的处理方式，插件反而限制了控制粒度）。

### 踩坑记录

1. **`logger` 选项不能传 pino 实例** — Fastify 5 会抛 `FST_ERR_LOG_INVALID_LOGGER_CONFIG: logger options only accepts a configuration object`。改用 `loggerInstance`。
2. **传 pino 实例会改变 `FastifyInstance` 的 logger 泛型** — 于是 `FastifyInstance`（默认为 `FastifyBaseLogger`）与实际实例类型不兼容，报 `childLoggerFactory` 不可赋值。解法：`src/api/app-instance.ts` 定义 `AppInstance = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>`，所有路由注册函数统一收这个类型。
3. **`disableRequestLogging` / `requestIdLogLabel` 在 5.12 已废弃** — 启动打 `FSTDEP023/024` 警告，两个选项直接删掉（Java 侧本就不记录请求日志）。
4. **`rootDir: "src"` 与 `include: ["test/**/*.ts"]` 冲突** — 每个测试文件报 `TS6059`（Wave 1 的三个移植任务各自独立撞上报错，因为 `npx tsc --noEmit` 会连带检查测试）。解法：`rootDir`/`outDir`/`sourceMap` 移到 `tsconfig.build.json`，`tsconfig.json` 只做类型检查。
5. **`toThreadSnapshot` 参数类型** — discord.js 的 `AnyThreadChannel.locked` 是 `boolean | null`，不是 `boolean`（见 P1 Discord 段）。

### 冒烟结果（8010 端口，dev 数据目录 `.devdata-node`）

```text
/health              200 {"status":"ok","service":"antigravity-backend","version":"1.5.3"}
/api/v1/health       200 {...,"version":"1.4.3"}     ← Python 侧此端点版本号是陈旧的，故意保留
/api/v1/ping         200 {"status":"pong","message":"API is reachable"}
/api/v1/debug/env    200 APP_DATA_ROOT/files_in_data/env_duckdb_data_dir:null
/api/v1/nope         404 {"detail":"Not Found"}      ← FastAPI 错误形状
/                    200 text/html 647B               ← frontend/dist 自动发现
```

---

## P1 — infra 层（四个模块并行移植）

四个模块相互独立，并行移植后统一装配。产物：14 个 TS 源文件 + 13 个测试文件，`npx vitest run` **143 tests / 13 files 全通过**，`npx tsc --noEmit` 零错误。

### fs：ProfileRepository / SessionRepository

- Java 的 `ReentrantReadWriteLock` → 单条串行 Promise 队列。理由：所有临界区内部都在 `await` I/O，用互斥队列即可保证「同一 profile 的读写不交错」，不需要真锁。
- `profiles.json` 用 `JSON.stringify(_, null, 2)`，Jackson pretty printer 的空格风格是 `"key" : value`。**仅格式差异，字段与顺序一致**，两个后端交替读写同一文件不会丢数据。
- 时间戳格式：本地 ISO（无时区后缀、毫秒精度），与 Java 的 `ISO_LOCAL_DATE_TIME` 对齐。
- **偏差**：`.duckdb` 文件过滤用 `Dirent.isFile()`，不跟随符号链接；Java 的 `Files.isRegularFile` 会跟随。真实用户目录里没有符号链接的 session 文件，暂不处理。
- legacy 迁移（`<app-home>/DuckDB_data` → guest profile）完整移植且幂等。
- SessionRepository 需要一个 Discord 能力来下载分享文件。Java 里 infra/fs 直接依赖 infra/discord 的具体类；Node 版改为声明结构化端口 `DiscordSessionGateway{ getThreadAttachments, downloadFile }`，由 `infra/discord/client.ts` 直接满足。好处：fs 层测试不必加载 discord.js，也不必实现 Discord 私有类型。

### duckdb：连接 / 读取 / 圈速边界 / metadata

- **占位符是 SQL 唯一改动处**：JDBC 的 `WHERE ts <= ?` → `WHERE ts <= $1`（`@duckdb/node-api` 的 prepared/inline 绑定语法），其余 SQL 逐字符照搬。
- Java 的 `open()` 未设访问模式，Node 版默认 `access_mode: 'read_only'`（游戏正在写文件时只读才安全），因此额外提供 `openReadWrite()` —— **`LapExportService` 导出时创建 output 库必须用它**。只读打开不存在的文件会抛错，正好对应 Java 的 `NoSuchFileError`。
- 连接释放：`connection.disconnectSync()` + `instance.closeSync()` 放在 `finally`。测试里用「关闭后立刻 `fs.renameSync(dbFile)`」来验证 Windows 文件句柄确实释放——句柄没放会失败。
- NULL 语义分两条路：`readValues` 这类返回 `Float64Array` 的，NULL → `NaN`（对应 Java `double` 默认 0/NaN 语义）；`scalarDouble` / metadata / 文本列 → `null`。BIGINT/HUGEINT 走 `Number(bigint)`；DECIMAL 按 Java `BigDecimal` 的截断行为处理。
- 流式接口按签名 `streamRows(conn, sql, onRow)` / `streamValues(conn, table, onChunk)` 提供，chunk ≤ 2048 行并带绝对行偏移，供遥测接口边读边写。

### track + car：赛道归一化与车辆目录

- `SequenceMatcher`（Python `difflib` 的手工移植）逐行照搬，未做任何「优化」：`2.0 * matches / total`、block 排序、`score >= bestScore` 的并列规则、`bestScore = 0.6` 阈值全部原样保留，并重新实现了 Java 的字符串语义（`javaTrim` 按 ≤ U+0020、`isBlank` 用 Java 空白集、ASCII-only `\s`/`\w`、NFD + `\p{Mn}` 去重音）。对照编译好的 Java 类跑了 914 + 90 + 278 组比较，无非预期差异。
- **发现的真 bug（已修）**：`CarCatalog.getCarInfo` 命中内置映射表时跳过了 steering-lock 覆盖参数。`LapService.java:183` 用的是三参重载，Node 版按新移植的 `car-catalog.test.ts`（33 组 Java golden）修正。这是移植过程本身的收益——测试先行逼出了 Java 调用点的真实语义。
- **与 Java 的行为差异（方向是更接近 Python）**：Java 用 `Map.copyOf(layouts)` 遍历布局候选，其迭代顺序**不保证**——同一输入 `"ricard - 1A"` 三次 JVM 运行分别返回 1A / 1A-V2 / 1A-V2-Short。Node 用 `tracks.json` 声明顺序（即 Python 的 `dict` 插入序），结果确定。有 2 条 golden 记录依赖此顺序。**这是 Java 侧的隐藏不确定性，Node 版的取舍是「可复现」优于「与 Java 逐次一致」。**

### discord：DiscordConfig + DiscordClient（改为 discord.js）

- 配置读写保持 Java 语义：候选文件路径、模板 `discord_config.template.json` 行为、字段名完全一致，用户既有的 `discord_config.json` 无需重配。
- Java 手写 REST → discord.js 对应关系：members/search → `guild.members.search`；GET member → `fetch(id)`（100073 → `null`）；建 forum 帖（手写 multipart）→ `forum.threads.create({name, message:{content, files}, appliedTags})`；活跃+归档两页合并 → `fetchActive()` + `fetchArchived({type:'public'})`；附件/头像 → `Attachment.url/size/name` + `embed/avatars/<BigInt % 6>.png`。TTL（60s / 15min）、20 条上限、雪花 ID 字典序倒排、标题 `---` 截断全部保持。
- **偏差**：① `created_at` 变成毫秒精度 `…+00:00`（discord.js 的 `Message` 丢弃了原始 ISO 的亚毫秒位）；② 建帖 body 多出 `auto_archive_duration` / `rate_limit_per_user`（库默认值，Discord 接受）；③ Java 手写的单次 429 重试由 `@discordjs/rest` 的退避取代，且 `rest.timeout=30s` 也作用于 GET（Java 的 GET 是 15s）；④ `client.login()` 会开 gateway websocket（计划 §10 已列为可接受代价）。
- 安全：token 不出现在任何响应/日志/错误文案，测试用三处断言覆盖（`Authorization failed for Bot [redacted]`、JSON 解析失败脱敏、响应体 `JSON.stringify`）。
- ESM 下的 discord.js（CJS 包）：类型用 `import type` 编译期擦除，运行时在工厂里 `await import('discord.js')`；测试用 `connect: false` + `setToken`，不登录就绝不建连，`npx vitest run test/infra/discord` 52 个用例全程不联网。

---

## P2 — application 层（11 个服务）

产物：`src/application/` 下 11 个服务 + 11 个测试文件，`npx vitest run` **435 tests / 25 files 全通过**，`tsc --noEmit` 零错误。这一层的原则是「数值与顺序照搬，I/O 用 Node 的异步模型重写」。

### 各服务的移植要点

| 服务 | 关键点 |
| --- | --- |
| `LapService` | 圈速边界推断逐条照搬：`ts - LapTime` 只在 `(firstBoundary+1, secondStart-1)` 内插入；<5 s 区间丢弃；`isValid` 要求 Lap Time 距圈尾 ≤0.5 s；出圈 = 第 0 圈或上一圈 in-pit；in-pit 后 stint+1。缓存键保留 Java 的两种形态：`header(path)` 仅按路径（`/laps`、导出、Telemetry 用），`header(path, {profileId, sessionId})` 给 SessionService 用。 |
| `FusionEngine` | 通道用 `Map` 保插入序（对应 `LinkedHashMap`），数值列统一 `Float64Array`；NaN 原样保留（写出时变 `null`）；距离按 `1/frequency` 积分并按每圈段归一化；`Ground Speed / 3.6` **只用于距离副本**，融合通道仍是 km/h。 |
| `Track3DService` | 图表 10 Hz / 3D 100 Hz；基准图取「最短的有效 stint 圈」，下限 5 s；stint 锚定容差 5 s；`zBase` + 最近点 Z 吸附（20 m 网格，保留 Java 除两次的 bucket 怪癖）；4000 是**除数**不是上限。 |
| `SessionService` | 扫描结果按 `size+mtime` 缓存；读取失败时仍返回 `{id,name,created,size}` 且**不缓存失败**；upload/rename/delete 清空两层缓存。 |
| `ReferenceLapService` | 遍历 profile 下所有文件、按赛道/布局/车组过滤、按圈速取最快有效圈；单个文件失败只记日志。 |
| `SetupService` / `SvmExporter` | `CarSetup` 的 Jackson 树形解析（`ValueNode`/`ObjectNode`）在 Node 用 `unknown` 判别；数字/布尔/字符串的渲染规则单独移植。SVM 生成逐行照搬，包括 `VehicleClassSetting`、`//Note: settings commented out...` 与空行位置。 |
| `LapExportService` | 输出库必须 `openReadWrite`；时间通道窗口 `ts >= start AND ts <= end + 1.0` 后整体平移 `start`；frame 表按 rowid 比例开窗；重导出覆盖同名文件。 |
| `TelemetryService` | 先 `assertFrequency` 再解析 session（保证 `freq` 越界先返回 400）；`lap_id` 优先于 `stint_id`；找不到圈/ stint → 404；返回值 `{frame, suspensionBaselines}`。 |
| `DiscordService` | 未配置 → 400；请求体缺失 → 400；handle 为空 → 400；分享内部的下载失败按 Java 包成 500；`profile_id` 空白回退 guest。 |
| `SystemService` | `validate-path` 只回 `{exists}`；`open-path` 找不到时打开父目录并返回 `partial`；导入路径先全量校验再复制；headless 文件选择器 → 400。 |
| `ProfileService` | `init()` 对应 `@PostConstruct`：创建 guest + 迁移 legacy 数据，由组合根调用且只调用一次。 |

### Track3D 测试失败排查（7 个用例）

结论：**实现是对的，错的是手算的测试数据**。三个根因：

1. **边界帧归属下一段**。`lowerBound` 是开区间，`d` 在边界帧上是 0，因此整圈距离跨度是 `2399.4` 而不是 `2400`；断言改为 `d[3999]=2639`、`d[4000]=0`。
2. **测试 fixture 没有触发它想验证的规则**。5 s 下限用例原先把 `Lap Time` 放在 50 s，反而制造了一个推断边界；重新设计成 30/35.5/60.5 三个边界后，4.9 s 的第 1 圈才真正被保留。stint 锚定用例原先把第 0 圈算进同一 stint；改成 0/3/8/38 边界并请求第 2 圈，`8 <= 3+5` 的容差分支才成立。
3. **速度单位与 Z 吸附的预期写反了**。融合后的 `Ground Speed` 是 216 km/h（3.6 除法只影响距离副本）；平面 GPS 下 `baseMap[0].z` 也不是最小值。断言改为与正确基准点比较 / 用不等式验证吸附确实发生。

### Node 特有问题

- DuckDB 连接是异步的，Java 的 try-with-resources 对应 `withConnection` 回调 + `finally` 双 close；测试用「关闭后立即重命名文件」验证 Windows 句柄已释放。
- `LapExportService` 与 `SvmExporter` 的输出都是整文件，不流式；只有 telemetry 需要流式（见 P3）。

---

## P3 — API 层（全端点 + 流式 telemetry）

产物：`src/api/` 下 9 个路由插件 + `route-helpers.ts`，`src/context.ts` 组合根，`test/api/routes.test.ts` 31 个用例。全量 `npx vitest run` **466 tests / 26 files**，`npm run build` 通过。

### 控制器对应关系

| Java 控制器 | Node 文件 | 端点 |
| --- | --- | --- |
| `HealthController` / `DebugController` / `IndexController` | `core-routes.ts` | `/health`、`/api/v1/health`、`/api/v1/ping`、`/api/v1/debug/env`、前端静态文件 |
| `ProfileController` | `profile-routes.ts` | `GET/POST /profiles`、`POST /profiles/reorder`、`PUT/DELETE /profiles/{id}`、`POST /profiles/{id}/avatar` |
| `SessionController` | `session-routes.ts` | `GET /sessions`、`POST /sessions/upload`、`POST /sessions/{id}/rename`、`DELETE /sessions/{id}` |
| `LapController` | `lap-routes.ts` | `GET /sessions/{id}/laps`、`GET /reference-laps` |
| `SetupController` | `setup-routes.ts` | `GET /sessions/{id}/setup`、`GET /sessions/{id}/setup/export` |
| `ExportController` | `export-routes.ts` | `GET /sessions/{id}/export/lap/{lapNumber}` |
| `TelemetryController` | `telemetry-routes.ts` | `GET /sessions/{id}/telemetry` |
| `Track3DController` | `track3d-routes.ts` | `GET /sessions/{id}/3d-track` |
| `DiscordController` | `discord-routes.ts` | `GET /discord/config`、`GET /discord/shares`、`POST /discord/shares/download`、`POST /sessions/{id}/discord/share` |
| `SystemController` | `system-routes.ts` | `GET /system/validate-path`、`POST /system/open-path`、`POST /system/import-paths`、`POST /system/pick-and-upload`、`GET /steering-wheels` |

### 参数与错误语义（`route-helpers.ts`）

- `profile_id` 到处默认 `guest`；`track_layout` 默认 `""`；`stint`/`stint_id`/`lap_id` 缺省为 `null`。
- 整数解析按 `Integer.valueOf` 的严格规则（可选符号 + 十进制数字），`1e3`、`" 1 "`、`0x10` 都是 400。
- 缺参数 / 参数类型错 / 路径段非整数统一 400 + `{detail}`。Java 对「缺必填参数」会被 catch-all 变成 500，Node 按计划 §6.1 固定为 400 —— **这是有意的契约偏差**。
- 错误处理器新增一条：Fastify 自带的 4xx（JSON 解析失败、content-type 不支持等）按 `statusCode` 原样返回，不再落到通用 500。Spring 对这些也是 400/415。

### 上传（multipart）

- `@fastify/multipart` 9.4.0，单文件上限 2 GB（对应 Spring `max-file-size: 2GB`）。
- **不缓冲整个文件**：`receiveUpload()` 先拉第一个 chunk。空文件直接 400 `File is required`（对应 `MultipartFile.isEmpty()`），否则用 `Readable.from(async generator)` 继续消费同一个迭代器，交给 `AtomicFiles.copyStream` 落盘。
- 服务在真正读取流之前拒绝时（扩展名不对等），`upload.close()` 会 destroy part，避免请求悬挂。
- 404/400 都在写响应前抛出，因此错误处理器仍然生效。

### 流式 telemetry

- 先 `telemetryService.load()` 完成全部校验（session/圈/stint 不存在都会正常返回 404），再 `reply.hijack()`。
- `reply.raw.writeHead(200, {'Content-Type': 'application/json;charset=UTF-8'})`，随后 `writeTelemetryJson(writableSink(reply.raw))` 边生成边写；背压由 writer 的 `drain` 处理。
- 客户端中断被 writer 吞掉（只记 debug 日志）；其他异常在响应头已发出后只能 `reply.raw.destroy()`，并记 error 日志。
- 端到端验证：合成 fixture 在 10 Hz 下输出 1201 帧、`lap_id=1` 输出 401 帧、`lap_id=99` 返回 404 `Lap 99 not found`。

### 下载

- `.svm`：`Content-Type: text/plain;charset=UTF-8`（与 Spring `MediaType` 的无空格写法一致），`Content-Disposition: attachment` 带文件名；非 ASCII 文件名额外输出 RFC 5987 的 `filename*`。
- lap 导出：`application/octet-stream` + 显式 `Content-Length` + 附件名，文件以 `createReadStream` 直接管道输出。

### 新增偏差清单（本阶段）

1. 缺必填查询参数 / 非法整数 → 400（Java catch-all 为 500）。
2. headless 下 `pick-and-upload` → 400 `Native file picker is unavailable in headless mode`（Java 经 `IllegalStateException` 变成 500）。
3. 无请求体的必需 JSON 接口 → Fastify 自身 400；统一成 `{detail}` 形状，便于前端只处理一种错误体。
4. `Content-Disposition` 中非 ASCII 文件名采用 `filename*=UTF-8''`（浏览器标准做法）；Java 的 `ContentDisposition.filename(name, UTF_8)` 也输出该参数，ASCII 部分两者一致。

### 组合根

`context.ts` 的 `buildContext()` 变为 **async**：`ProfileService.init()` 必须在监听端口前完成。依赖装配顺序：

```text
Env → AppPaths
  ├─ DiscordConfig → DiscordClient
  ├─ ProfileRepository → ProfileService
  ├─ SessionRepository(paths, DiscordClient)
  ├─ DuckDbConnectionFactory / MetadataReader / TrackRegistry / CarCatalog
  ├─ LapService → SessionService / ReferenceLapService
  ├─ FusionEngine → TelemetryService / Track3DService
  ├─ SetupService / SvmExporter → LapExportService
  └─ DiscordService / FilePicker / SteeringWheelScanner → SystemService
```

`AppContextOptions.fileDialog` 是 Electron 主进程注入原生对话框的入口；未注入时 `FilePicker` 走 headless 分支。

---

## P4 — Parity 工具与剩余联调

仓库里没有计划中提到的 `tools/parity/*.py` 与 `testdata/duckdb/`（Java 版只在提交说明里引用过），所以对拍分三层，前两层已经自动化：

1. **移植后的单元测试**：Java 的 6 个测试类已逐一移植，另有合成 fixture 覆盖 fusion / lap / 3D / export。当前 `npx vitest run`：**26 files / 466 tests 全通过**；`npx tsc --noEmit` 与 `npm run build` 均无错误。
2. **合成 DuckDB fixture**：`test/helpers/duckdb-fixture.ts` 用 `@duckdb/node-api` 现场生成多 stint 会话，路由测试还会把它复制进 guest profile 走完整 HTTP 路径（`/laps`、`/telemetry`、`/3d-track`、`/setup`、`/setup/export`、`/export/lap/{n}`）。
3. **活体对拍（需要真实 session）**：`tools/parity/live-parity.mjs`。

### 活体对拍用法

```bash
# 三个后端各自监听（Node 默认就是 8000）
SERVER_PORT=8012 <python backend>
SERVER_PORT=8011 java -jar backend-java/target/....jar
SERVER_PORT=8010 node backend-node/dist/server.js

cd backend-node
node tools/parity/live-parity.mjs --session 2026_05_04_....duckdb --lap 1
```

脚本对 `java↔python`、`node↔java`、`node↔python` 三组两两比较以下只读端点：`/health`、`/api/v1/health`、`/ping`、`/profiles`、`/discord/config`、`/steering-wheels`、`/sessions`、`/laps`、`/telemetry`（整场 10 Hz 与单圈 60 Hz）、`/3d-track`、`/setup`，以及文本形式的 `/setup/export`。JSON 数值默认绝对容差 `1e-6`（`--tolerance` 可调），`null` 与 NaN 视为同值；任一差异会打印到 `$.channels[...]` 级别的路径并以退出码 1 结束。三个后端必须指向同一份 session 数据（同一 `APP_DATA_DIR` 或各自复制同一文件）。

### Electron 联调（未执行）

`desktop/main.js` 开发模式假定 8000 端口已有后端，生产模式则 spawn `resources/backend-dist/.../lmu-telemetry-backend.exe`。用 Node 后端联调时：

```bash
cd backend-node
npm run build
SERVER_PORT=8000 APP_DATA_DIR=<数据目录> node dist/server.js
# 另开一个终端
cd desktop && npm start
```

预期路径：`GET /` 由 Node 托管 `frontend/dist`（`LMU_FRONTEND_DIR` 可覆盖）→ 导入 session → `/laps` → `/telemetry` → `/3d-track`。**这一步需要在有显示环境的机器上人工确认**，本移植环境没有执行。若要在打包产物中替换后端，需要把 `dist/` 与原生 DuckDB `.node` 一起放进 `resources/backend-dist`，并按 `package.json` 的打包脚本调整入口（计划 §10 的 ABI 风险仍适用）。

---

## 已移植模块的导出接口（装配与后续移植的依据）

> 这段是给「接力移植下一个模块的人/agent」看的。所有路径相对 `backend-node/src/`。

**domain/types.ts** — `Channel`（class，`scalar/vector/fromFlat` 工厂 + `valueAt/frames`，数据用 `Float64Array`）、`FusedFrame{frequency,time,channels:Map}` + `channelOf/hasChannel/scalarChannel/channelMap`、`LapInfo`、`LapsResponse`、`Profile`、`ReferenceLap`、`SessionInfo`、`SessionMetadata`、`TrackSectorPoint`、`Track3DPoint/Response/SectorPoint/Center`、`TrackDefinition/TrackLayout/ElevationPoint` + `officialLength(layout)`。

**api/** — `error.ts`: `ApiException(status, message, {cause?})`、`NoSuchFileError(file)`、`registerErrorHandler(app, logger)`；`app-instance.ts`: `AppInstance`；`dto.ts`: `CreateProfileRequest`/`UpdateProfileRequest`/`ReorderProfilesRequest`/`RenameSessionRequest`/`OpenPathRequest`/`ImportPathsRequest`/`DiscordShareRequest`/`DiscordDownloadRequest`；`core-routes.ts`: `registerHealthRoutes`/`registerDebugRoutes`/`registerFrontendRoutes`/`contentTypeFor`；`route-helpers.ts`: `GUEST_PROFILE`/`MAX_UPLOAD_BYTES`/`queryValue`/`profileIdParam`/`requiredParam`/`defaultedParam`/`optionalIntParam`/`requiredIntParam`/`intParamOrDefault`/`pathParam`/`pathIntParam`/`bodyObject`/`requiredBodyObject`/`bodyString`/`bodyNumber`/`bodyBoolean`/`bodyStringArray`/`receiveUpload`/`attachmentDisposition`；`telemetry-writer.ts`: `writeTelemetryJson`/`writableSink`/`memorySink`/`isClientDisconnect`/`ClientDisconnectedError`/`formatJavaDouble`；路由插件：`registerProfileRoutes`/`registerSessionRoutes`/`registerLapRoutes`/`registerSetupRoutes`/`registerExportRoutes`/`registerTelemetryRoutes`/`registerTrack3DRoutes`/`registerDiscordRoutes`/`registerSystemRoutes`。

**application/** — `ProfileService(repo, paths, logger)` → `init/list/create/reorder/update/delete/uploadAvatar`；`SessionService(repo, laps, tracks, logger)` → `list/scan/upload/rename/delete/resolve`；`LapService(conns, metadata, tracks, cars, logger)` → `header(db, identity?)/clearCache`；`ReferenceLapService(repo, laps, logger)` → `find(profile, track, layout, class)`；`TelemetryService(sessions, laps, fusion)` → `load(profile, session, freq, stint?, lap?)`；`Track3DService(sessions, laps, fusion)` → `build(profile, session, lap, stint?)`；`SetupService(sessions, conns, metadata)` → `getSetup/readSetup/readMetadata`；`SvmExporter(conns, metadata)` → `generate(db)`；`LapExportService(sessions, laps, setup, cars, conns, paths, logger)` → `export(profile, session, lap, customCarModel)`；`DiscordService(config, gateway, sessions, laps, exporter, svm, setup, cars, paths, logger)` → `config/shares/share/download`；`SystemService(repo, picker, wheels, paths, logger)` → `validatePath/openPath/importPaths/pickAndUpload/steeringWheels`。

**context.ts** — `buildContext(options?): Promise<AppContext>`（async，内部完成 `ProfileService.init()`）、`AppContextOptions{env?, logger?, fileDialog?}`、`AppContext` 暴露所有服务 + `paths/env/logger/sessionRepository/carCatalog`。

**infra/fs/** — `AppPaths(env, logger)` + `.init()`、字段 `appHome/dataRoot/gameTelemetryDir|null/frontendDir/steeringWheelDir`、方法 `profilesFile/profileRoot/profileDataDir/profileCacheDir/profileAvatarDir/legacyDataDir/ensureProfileDirs/version/devMode/platform`；`AtomicFiles.{writeString,writeBuffer,copy,copyStream,move,deleteRecursively}` + `exists/isRegularFile/isDirectory`；`PathSafety.{resolveUnder,safeFileName,isDuckDb,stripDuckDb}`；`ProfileRepository(paths, logger)` → `list/find/ensureGuest/create/updateName/updateAvatar/reorder/delete/migrateLegacyData`；`SessionRepository(paths, discord: DiscordSessionGateway, logger)` → `listFiles/resolve/upload/importPaths/rename/delete/clearCache`，类型 `IncomingFile{filename, stream: Readable, size?}`、`UploadedSession{id, size}`。

**infra/system/** — `SteeringWheelScanner(paths).scan(): Promise<{categories}>`、`FilePicker(dialog: NativeFileDialog|null, logger).pick(req): Promise<string[]>`（无桥接即 headless 报 400）。

**infra/duckdb/** — `DuckDbConnectionFactory{open, openReadWrite, withConnection<T>, withReadWriteConnection<T>}`、`DuckDbSession{database, connection, isClosed, run, runAndReadAll, stream, close}`；`reads.ts`（建议 `import * as DuckDbReads`）：`readValues/readValuesOrEmpty/readColumn/lastEventBefore/lastEventWheelBefore/readEvents/readEventsColumn/readEventsOrEmpty/readEventWheels/readWheelValues/tableNames/columns/scalarDouble/scalarInt/readRows/toNumber/toNumberOrNull/toText` + 流式 `streamValues/streamColumn/streamRows`；`lap-boundaries.ts`: `resolve(conn) → {sessionStart, sessionEnd, boundaries, lapTimes}`；`metadata.ts`: `MetadataReader(logger)` → `read(conn) → Map<string,string|null>`、`value(metadata, key, fallback)`。

**infra/track/** — `sequence-matcher`: `ratio(a,b)`、`matchingBlocks(a,b)`；`track-names`: `normalizeTrack/normalizeLayout/stripLeadingNonAlnum/stripAccents/collapseWhitespace/javaTrim/isBlank`；`layout-matcher`: `matchLayout(definition, rawLayout, rawTrack) → LayoutMatch|null`；`track-matcher`: `matchTrack(searchName, registry) → TrackMatch|null`；`track-registry`: `TrackRegistry(logger?)` → `load()/tracks()/findTrack()/findLayout()`。**注意 `load()` 是同步的**（`tracks.json` 静态 import，构建后会随 `dist/infra/track/tracks.json` 一起产出）。

**infra/car/** — `CarSpec{modelName, category, steeringLock}`、`CarCatalog.getCarInfo(carNameMeta, carClassMeta, overrideSteerLock?)`、`parseSteerLock(value)`。

**infra/discord/** — `DiscordConfig(paths: {appHome, dataRoot}, options?: {env?, logger?})` → `load/isConfigured/inviteUrl/guildId/channelId(carClass)/save/ensureConfigFromTemplate/configFile/candidateFiles/templateFile`；`DiscordClient(config, options?: {gatewayFactory?, logger?, fetch?, now?})` → `isConfigured/inviteUrl/shareToForum/searchGuildMember/getGuildMember/listSharedLaps/getThreadAttachments/downloadFile/connect/close`。`getThreadAttachments/downloadFile` 直接满足 `SessionRepository` 的 `DiscordSessionGateway` 端口。
