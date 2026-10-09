# 参与贡献

感谢你愿意参与。这个插件很小，但有几条约定是踩过坑才定下来的，改动前请先读。

## 环境

需要 **Node.js ≥ 20**（开发时用的是 24）。无需 `npm install` —— 本插件没有
第三方依赖，`node_modules` 是空的，测试直接用 Node 内置能力跑。

```bash
node tests/run_tests.js          # 115 项：探测逻辑、指标口径、各类故障
node tests/run_client_tests.mjs  #  75 项：界面数据契约与文案契约
node tests/run_route_tests.js    #  26 项：HTTP 路由、安全栅栏、NDJSON 流
node tests/check_providers.mjs   # 供应商地址结构校验（加 --online 逐个探测）
```

## 硬性约定：三个套件都要跑

`tests/` 下有**三个**套件，各自覆盖不同层面。只跑一个就宣称「可以上线」是本项目
真实犯过的错误，并且造成了假绿：

> 给 `PRESETS` 加了 `.sort(...)` 后，测试里提取它的正则要求数组以 `];` 结尾，
> 匹配失败 → 字面量为 `null` → 整块断言被 `if (literal)` 跳过 →
> **19 条断言静默失效**，套件仍然只报别的 1 条失败，甚至不显示「失败」。

现在提取失败会直接判失败，但这个坑的本质没变：**改结构就要跑对的那套件**。

| 你改了什么 | 至少要跑 |
|---|---|
| `lib/index.js` | 三个都跑 |
| `lib/client.js` | `run_client_tests.mjs` + `run_tests.js` |
| `PRESETS` | **`run_client_tests.mjs`**（另外两个看不到它） |
| 路由 / 安全栅栏 | `run_route_tests.js` |

## 不要做的事

- ❌ **不要给预设加模型名或静态 `hints`。**
  同一个模型在不同厂商 ID 完全不同（NVIDIA 的 `deepseek-ai/deepseek-v4.1-flash`、
  Cloudflare 的 `@cf/deepseek/deepseek-v4.1-flash`、深度求索官方的 `deepseek-chat`），
  中转站还会再改一次名，而且模型随时下架。过期的芯片看起来很权威，
  却会直接把人送进 400 错误 —— 那比什么都不给更糟。
  权威来源只有一个：该地址自己的 `/models` 响应。
- ❌ **不要用 `localeCompare("zh")` 排序。**
  它走宿主 ICU，不同版本排序可能不同，会导致下拉列表在不同机器上顺序不一致。
  用 ASCII 的 `sort` 键。
- ❌ **不要放宽探测路由的回环限制。**
  放宽后，任何能访问该端口的人都能用你的 Key 去请求任意地址。

## 改供应商列表之后

预设里的 base URL 是**唯一无法从服务端推导出来的字符串**——必须有人知道它，
而且厂商会不打招呼地换域名。所以：

```bash
node tests/check_providers.mjs --online
```

它不需要 Key，靠状态码判断：`200` / `401` / `403` / `405` 说明地址是对的，
`404` 说明路径写错了。

**不要一次全打。** 37 条无鉴权请求同时涌向一批网关，容易被当成异常流量。
抽检几家就够：

```bash
node tests/check_providers.mjs --online --only=xfeng,deepseek,nvidia
```

判读时注意：**`UNREACHABLE` / `TIMEOUT` 多半是你本机的网络或区域限制，不等于地址错**；
只有 `MISSING` / `UNRESOLVED` 才值得去改，而改之前先找官方文档核对 ——
不要凭印象改 URL，本项目已经因此填错过一次（讯飞星火曾经写成不存在的
`xfarh.cn`，已修正为 `spark-api-open.xf-yun.com`）。

## 提交前

- [ ] 三个套件全绿，且**确认输出里的「全部通过：N 项」数量没有突然变少**
- [ ] 改动如果涉及界面，中英文文案都改（`zh` / `en` 两份字典）
- [ ] 诊断结论要跟着证据走，不要替服务商下你并不知道的结论
- [ ] 如果动了预设顺序，同步更新 `run_client_tests.mjs` 里的提取正则
      （并确认那条「提取失败即判失败」的断言还在）