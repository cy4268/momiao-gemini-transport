# Momiao Gemini 防截断与模型路由 0.2.0

独立的 SillyTavern / TauriTavern 前端扩展。它让 Gemini 把最终正文放进一个工具的 `content` 参数，再实时还原为普通聊天文字。魔法棒菜单中的「Momiao 模型路由」可查看请求模型与响应里的模型字段。不会运行模型生成的代码。

兼容性源码基线：**SillyTavern 1.19.0、TauriTavern 2.4.0**。用户设备中的实际安装和完整公网链路尚待验收。代码不依赖旧版 Vertex 插件、Tavern Helper、SPreset、服务端插件或另一个网关。

## 安装

**推荐：Git 安装（ST / TT 通用）**

在酒馆的「扩展 → 安装扩展」粘贴以下地址：

```text
https://github.com/cy4268/momiao-gemini-transport
```

安装后刷新或重启酒馆。后续可通过扩展管理器更新。无需服务端插件、`npm install` 或单独配置密钥。

**离线安装：**到 [Releases](https://github.com/cy4268/momiao-gemini-transport/releases/latest) 下载对应附件。标准 SillyTavern 使用 `Momiao-Gemini-0.2.0-ST.zip`，把其中的 `momiao-gemini-transport` 文件夹解压到酒馆的：

```text
data/<你的用户目录>/extensions/momiao-gemini-transport/
```

该文件夹里应直接看到 `manifest.json` 和 `index.js`，不要再套一层同名目录。刷新酒馆，在「扩展设置」中找到「Momiao Gemini 防截断」。这是前端扩展，不放进 `plugins/`，也不需要 `npm install`。

**TT 2.4.0：**使用单独的 `Momiao-Gemini-0.2.0-TT-import.zip`，不解压，交给 TT 的数据导入功能。导入结束后重启 TT，再打开扩展设置。这个包的所有文件都位于 `extensions/third-party/momiao-gemini-transport/`，不含聊天、角色、密钥、数据库或设置文件。已按 TT 2.4.0 固定源码核对识别与合并规则，实际设备导入尚待验收。

两个包内容相同，只是目录布局不同。标准 ST 包、GitHub 自动生成的 Source code ZIP 都不能直接当 TT 数据包导入。离线安装没有 Git 更新来源；更新时导入新版包。已离线安装 0.1.0 的用户可直接覆盖更新；如改用 Git 安装，先在扩展管理器移除旧副本再安装，避免同时加载两份。

## 第一次使用

1. 先关闭原来的 Vertex 防截断扩展、S 喵防截断脚本，以及预设中 `izumi_content` / `game_content` 等输出工具。预设普通的角色、文风内容可以保留。多个防截断拦截器同时运行不在本版验收范围内。
2. 酒馆连接选择「聊天补全 → 自定义」。TT 的协议选择 **OpenAI Chat Completions**。
3. 沿用原来的 `https://momiao.win/v1` 地址、API 密钥和完整模型名，例如 `AIS/gemini-4-argon`、`快速v/gemini-4-argon`。插件不单独保存密钥。
4. 在「扩展设置 → Momiao Gemini 防截断」打开「启用正文工具传输」。默认关闭。
5. 点输入框旁的**魔法棒 → Momiao 模型路由**，也可从扩展设置点「查看模型路由」。先发一句简短问候，观察状态和模型字段。如果状态写明冲突，先处理提示的已有工具或附加参数。

流式和非流式跟随酒馆本来的选择；插件没有第二套流式开关。停止按钮仍由酒馆控制。「继续」仍由用户点击发起，插件不会自动重试或连续请求。开关变化对下一次请求生效，不会撤销正在进行的请求。

## 模型路由面板能证明什么

面板分别列出「发送的模型名」和响应中的 `model` / `modelVersion` 字段（也识别嵌套 `response` 字段）。保留字段的原始名称和值，缺失时显示未提供。观察默认开启，与正文工具开关独立；不会额外发送请求。

- 返回名称不同：提示核对差异，**不自动断言降级**。别名、版本后缀和中转映射都可能造成差异。
- 返回名称相同：仍不能证明实际执行模型相同。
- 上游不提供真实信息、或适配器使用请求名回填：显示无法核实。不能通过生成速度、写作风格或让模型自报身份来可靠识别隐藏模型。

2026-10-27 源码核对发现，当前部分 Momiao 连接的适配器会用请求名填写模型字段：AIS-PG 的 `modelVersion`、快速v / AIStudioToAPI 的 OpenAI `model` 均存在这种情况；原生 Gemini 转 OpenAI 的中转还可能再次用配置名填充 `model`。本扩展不会把这些字段标成已经验证的 Google 实际执行版本。**现有这些链路仍无法据此确认 Google 内部是否换了模型。** 若将来上游真实版本完整透传到响应中，面板会显示收到的字段，但字段自身仍是上游的声明。

只保留当前页面最近 10 条元数据，刷新清空；可手动清空。不存提示词、回复正文或密钥，不上传诊断记录。面板里的「响应读取结束」只表示网络响应读完，不代表回复完整、抗截断有效或模型身份已核实。

## 生效条件与限制

- 只处理发往 **HTTPS momiao.win** 的自定义 OpenAI Gemini 聊天请求。保留渠道前缀，不改变模型名或用户的输出上限。
- 仅支持一个候选回复、一个正文输出工具。已有工具历史、工具配置、联网/生图、结构化输出或附加参数冲突时，保留原请求并显示原因。
- 附加请求体支持空值或 JSON 对象。为了不破坏用户配置，首版不改写 YAML；非空的排除字段也需要先检查处理。
- 输入中的图片由原连接处理，插件不转换图片。生成图片的模型不属于本插件范围。
- 普通辅助生成（`quiet`）、扮演用户（`impersonate`）保持原请求。
- 内容过滤、达到 token 上限、超时和网络断开仍可能发生。已收到的文字会尽量保留，并显示异常；未收到的内容无法恢复。本插件不能保证规避审核或完全消除截断。
- 发送后上游若没有调用工具，插件显示普通回复并明确提示，不能将其当作防截断成功。
- 单条工具参数限制为 4 MiB 字符；此限制防止异常响应无限占用内存。

## 验证范围

0.1.0 阶段的两次短调用验证过快速v、AIS-PG 的上游工具能力，没有验证长篇抗截断成功率，也没有经过用户设备中的 ST / TT。0.2.0 复用现有回归测试检查模型字段观察，没有新增真实模型调用或变更生产服务配置。

## 关闭与卸载

关闭「正文工具传输」后不再改写后续请求；「观察模型字段」可以继续独立工作。关闭两个开关，或在扩展管理器停用后刷新酒馆，后续请求完全透传。卸载只删除本扩展目录，不删除聊天、角色卡、预设和连接设置。

## 开发验证

无构建步骤、无第三方依赖。复用一条完整传输回归测试，覆盖跨分片文字、提前显示、异常结束、长度上限、停止接收、非流式还原，以及返回模型差异、字段缺失、仅观察时原始字节不变。验证命令：

```sh
node --test transport.test.mjs
node --check index.js
node --check transport.mjs
node --check routing.mjs
```

真实客户端的安装、魔法棒菜单与弹窗布局、启停、设置持久化、取消、继续与公网链路须另做最小验收。`capability-contract.json` 记录需要的宿主能力；没有伪造“已捕获”的运行时快照。

## 来源与接口依据

- [原帖：AI Studio 代码执行实验](https://linux.do/t/topic/2619263)。本插件选用的是附件中展示的函数参数传输路线，二者机制不同。
- [Google 函数调用](https://ai.google.dev/gemini-api/docs/function-calling)与[代码执行](https://ai.google.dev/gemini-api/docs/code-execution)。
- [SillyTavern 1.19.0 固定源码](https://github.com/SillyTavern/SillyTavern/tree/7e8663cd9c184a550b37238218bdd32c6efc68e9)：`public/scripts/openai.js`、`public/scripts/extensions.js`、`src/endpoints/backends/chat-completions.js`。
- [TauriTavern 2.4.0 固定源码](https://github.com/Darkatse/TauriTavern/tree/fff9af0333be97697be2313981699ab0ce35c236)：`src/scripts/openai.js`。
- 两个版本的 `scripts/st-context.js` 提供 `Popup` / `POPUP_TYPE` / `POPUP_RESULT`；`scripts/extensions.js` 创建 `#extensionsMenu`，弹窗签名和生命周期来自各自 `scripts/popup.js`。使用宿主原生界面，不依赖 Tavern Helper。
- [Google 响应字段说明](https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse)：`modelVersion` 是 API 响应元数据；本插件不能验证转发方有没有改写它。
- TT 离线包依据同一版本的 `src-tauri/crates/tt-adapter-archive/src/data_archive/import/layout.rs`（识别全局扩展目录）、`apply.rs`（逐文件合并）及[第三方扩展兼容说明](https://github.com/Darkatse/TauriTavern/blob/fff9af0333be97697be2313981699ab0ce35c236/docs/CurrentState/ThirdPartyExtensions.md)；不把静态源码核对写成设备实测。

附件仅用于理解机制；本项目没有执行、打包或复制其中的大型内嵌脚本、远程加载器及角色提示词。

## 许可

MIT，见 [LICENSE](LICENSE)。
