# 安全策略

## 支持的版本

| 版本 | 状态 |
|---|---|
| 1.0.x | ✅ 接收安全修复 |

## 报告漏洞

**请不要用公开 Issue 报告安全漏洞。** 用 GitHub 的
[私密漏洞上报](https://docs.github.com/code-security/security-advisories/guidelines/reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)（Security → Report a vulnerability）。

请尽量包含：受影响的版本、复现步骤、影响面判断。

## 这个插件会碰什么敏感数据

先说清楚信任边界，方便你判断自己的风险：

- **API Key**：只在一次探测请求里使用，**不写入磁盘、不发往任何第三方**。
  面板里的报告会把 Key 打码成 `sk-a****xyz`。
- **地址、模型、超时、代理**：这些设置会被记住（存在浏览器本地存储里），**Key 不会被记住**。
- **探测路由**：为了拿你的 Key 并向外发起请求，路由做了 loopback 限制
  （仅 `127/8`、`::1`、IPv4-mapped 回环地址，外加 Host 头与
  `sec-fetch-site` / `Origin` 同源三重校验，`X-Forwarded-For` 一律不信）。
  配对设备走 `remoteWebUiPairing` 单独放行。
- **代理**：填了代理地址时，请求会经由你填的那个代理转发。

也就是说：Key 的流向只有「你 → 你要测的那个服务商」，没有第三方。
如果你在不受信任的机器上使用，请确保 Harness 本身的可信。

## 部署给他人前的建议

如果你要把插件分发给别人：探测路由默认只允许回环地址，这是有意的。
请不要为了「方便远程用」而放宽这个限制 —— 放宽后，任何能访问该端口的人
都能用你的 Key 去请求任意地址。