/**
 * Regression suite for the dsh-api-probe host half.
 *
 * Every test drives the real `runProbe` against a real socket — the point of
 * this tool is timing, so mocking the transport would test nothing worth
 * testing. Run:  node tests/run_tests.js
 */

import http from "node:http";
import { startMockApi, KEY } from "./mock_api.js";
import { runProbe, normBase, pickModel, estimateTokens, diagnose, explainPhase, nearestModelName } from "../lib/index.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
	if (condition) {
		passed += 1;
		console.log(`  PASS  ${name}`);
	} else {
		failures.push(`${name}${detail ? " — " + detail : ""}`);
		console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
	}
}

function section(title) {
	console.log("\n" + title);
}

async function silentProbe(overrides) {
	const events = [];
	const cfg = {
		base: "", key: KEY, model: "", api: "openai", timeout: 10000, maxTokens: 64,
		rounds: 3, concurrency: 1, prompt: "hi", proxy: "", insecure: false,
		...overrides,
	};
	const result = await runProbe(cfg, (event) => events.push(event));
	return { result, events };
}

const mock = await startMockApi(0);

try {
	// ---------------------------------------------------------------- pure
	section("纯函数");
	check("normBase 裸域名补 /v1", normBase("api.openai.com") === "https://api.openai.com/v1", normBase("api.openai.com"));
	check("normBase 保留显式路径", normBase("https://x.cn/compatible-mode/v1") === "https://x.cn/compatible-mode/v1");
	check("normBase 去掉尾斜杠", normBase("https://x.cn/v1/") === "https://x.cn/v1");
	check("normBase 无路径也补 /v1", normBase("http://127.0.0.1:8899") === "http://127.0.0.1:8899/v1", normBase("http://127.0.0.1:8899"));
	// joinUrl() concatenates strings, so a query string left on the base would
	// swallow the "/chat/completions" suffix and turn every request into a 404.
	check("normBase 剥掉查询串（否则 joinUrl 会把路径塞进 query）", normBase("https://x.cn/v1?api-version=2024-05") === "https://x.cn/v1", normBase("https://x.cn/v1?api-version=2024-05"));
	check("normBase 剥掉片段", normBase("https://x.cn/v1#frag") === "https://x.cn/v1", normBase("https://x.cn/v1#frag"));
	check("normBase 裸域名带查询串仍补 /v1", normBase("x.cn?api-version=1") === "https://x.cn/v1", normBase("x.cn?api-version=1"));
	check("pickModel 显式优先", pickModel("my-model", ["gpt-4o-mini"]).model === "my-model" && pickModel("my-model", ["gpt-4o-mini"]).auto === false);
	check("pickModel 跳过 embedding", pickModel("", ["text-embedding-3-small", "gpt-4o-mini"]).model === "gpt-4o-mini");
	check("pickModel 跳过 rerank", pickModel("", ["bge-reranker-v2", "deepseek-chat"]).model === "deepseek-chat");
	check("pickModel 无可用时返回空", pickModel("", ["text-embedding-3-small"]).model === "");
	check("pickModel 无候选时自动标记", pickModel("", ["weird-1", "weird-0"]).auto === true);

	// ---- "did you mean" for a model name the provider does not offer ----
	// Capitalisation alone is the most common real mismatch, and an edit-distance
	// search alone would miss it, so case-insensitive equality has to win outright.
	check("nearestModelName 只差大小写", nearestModelName("SENSENOVA-LITE", ["SenseNova-Lite", "qwen-plus"]) === "SenseNova-Lite");
	check("nearestModelName 差一个字符", nearestModelName("gpt-4o-min", ["gpt-4o-mini", "qwen-plus"]) === "gpt-4o-mini");
	check("nearestModelName 差一个字符也能命中", nearestModelName("gpt-4o-mimi", ["gpt-4o-mini", "deepseek-chat"]) === "gpt-4o-mini");
	check("nearestModelName 完全不相关时不给建议", nearestModelName("totally-different-thing", ["gpt-4o-mini", "qwen-plus"]) === null);
	check("nearestModelName 空输入安全", nearestModelName("", ["gpt-4o-mini"]) === null);
	check("nearestModelName 空列表安全", nearestModelName("gpt-4o-mini", []) === null);
	check("nearestModelName 非数组安全", nearestModelName("gpt-4o-mini", undefined) === null);
	check("estimateTokens 英文", estimateTokens("a".repeat(40)) === 10, String(estimateTokens("a".repeat(40))));
	check("estimateTokens 中文", estimateTokens("我".repeat(10)) === 10, String(estimateTokens("我".repeat(10))));
	check("estimateTokens 空串", estimateTokens("") === 0);
	check("diagnose 401", diagnose({ status: 401, errorText: "", cfg: {} }).title === "Key 无效");
	check("diagnose 429", diagnose({ status: 429, errorText: "", cfg: {} }).title.includes("限流"));
	check("diagnose ENOTFOUND", diagnose({ status: 0, errorText: "getaddrinfo ENOTFOUND x", cfg: {} }).title === "域名解析不了");
	check("diagnose 超时提示代理", diagnose({ status: 0, errorText: "ETIMEDOUT", cfg: { proxy: "" } }).hint.includes("代理"));
	check("diagnose 有代理时不叫错", diagnose({ status: 0, errorText: "ETIMEDOUT", cfg: { proxy: "http://127.0.0.1:1" } }).hint.includes("代理地址"));

	// 2xx-with-no-content is the case that used to be reported as
	// "意料之外的状态码 200" — technically true, actionable for nobody.
	const empty200 = diagnose({ status: 200, errorText: "服务端连上了、状态也是 200，但一个字的正文都没返回", cfg: {} });
	check("diagnose 200 空内容不再是意外状态码", !empty200.title.includes("意料之外"), empty200.title);
	check("diagnose 200 空内容说人话", empty200.title.includes("200") && empty200.title.includes("空"), empty200.title);
	check("diagnose 200 空内容给出三条出路", empty200.hint.includes("风控") && empty200.hint.includes("模型名") && empty200.hint.includes("中转站"));
	check(
		"diagnose 200 欠费",
		diagnose({ status: 200, errorText: '{"error":{"message":"insufficient balance"}}', cfg: {} }).title === "欠费或额度用尽",
		diagnose({ status: 200, errorText: '{"error":{"message":"insufficient balance"}}', cfg: {} }).title,
	);
	check(
		"diagnose 200 模型不存在",
		diagnose({ status: 200, errorText: "model not found: gpt-4o-mini", cfg: {} }).title === "模型名不被认可",
	);
	check("diagnose 200 权限", diagnose({ status: 200, errorText: "permission denied for this model", cfg: {} }).title === "这个 Key 没有调用权限");
	check("diagnose 200 风控", diagnose({ status: 200, errorText: "content filtered by safety policy", cfg: {} }).title === "内容被风控拦了");
	check(
		"diagnose 200 未知错误保留原文",
		diagnose({ status: 200, errorText: "weird gateway thing", cfg: {} }).detail.includes("weird gateway thing"),
	);
	check("diagnose 201 也不算意外", !diagnose({ status: 201, errorText: "", cfg: {} }).title.includes("意料之外"));

	// ---- phase: where did it die, and did any byte ever leave the machine? ----
	// The bug this locks down: a stalled request and a never-sent request used to
	// both surface as "no response", which let the tool accuse an API of being
	// broken when all it knew was that its own request went quiet.
	check("phase connect 说清没发出去", diagnose({ status: 0, errorText: "boom", cfg: {}, phase: "connect" }).title.includes("根本没发出去"));
	check("phase tls 单独归因", diagnose({ status: 0, errorText: "boom", cfg: {}, phase: "tls" }).title.includes("TLS"));
	check("phase closed 说是对端断的", diagnose({ status: 0, errorText: "boom", cfg: {}, phase: "closed" }).title.includes("服务商立刻断开"));
	check("phase wait-status 承认请求已发出", diagnose({ status: 0, errorText: "请求超时", cfg: {}, phase: "wait-status" }).title.includes("已发出"));
	check(
		"phase wait-status 报出实际写出的字节数",
		diagnose({ status: 0, errorText: "请求超时", cfg: {}, phase: "wait-status", trace: { sentBytes: 312 } }).detail.includes("312 字节"),
	);
	check("phase wait-first-token", diagnose({ status: 0, errorText: "x", cfg: {}, phase: "wait-first-token" }).title.includes("200"));
	// 404 must report the path actually requested without pretending to know which
	// provider convention the user violated.
	check("404 如实报出请求的路径", diagnose({ status: 404, errorText: "", cfg: { base: "https://integrate.api.nvidia.com/v1" } }).detail.includes("/chat/completions"), diagnose({ status: 404, errorText: "", cfg: { base: "https://integrate.api.nvidia.com/v1" } }).detail);
	check("404 不臆断是少了 /v1", !diagnose({ status: 404, errorText: "", cfg: { base: "https://integrate.api.nvidia.com/v1" } }).title.includes("/v1"));
	// An HTTP status is hard evidence — the phase must never override it.
	check(
		"有 HTTP 状态码时 phase 不得改写诊断",
		diagnose({ status: 401, errorText: "", cfg: {}, phase: "wait-status" }).title === "Key 无效",
		diagnose({ status: 401, errorText: "", cfg: {}, phase: "wait-status" }).title,
	);
	check(
		"有 HTTP 状态码时 200 空内容也不被 phase 改写",
		diagnose({ status: 200, errorText: "正文都没返回", cfg: {}, phase: "closed" }).title.includes("内容是空的"),
	);
	check("未知 phase 退回老逻辑", diagnose({ status: 0, errorText: "ETIMEDOUT", cfg: {}, phase: "weird" }).title === "连不上（超时）");

	check("explainPhase connect", explainPhase({ phase: "connect" }).includes("一个字节都没发出去"));
	check("explainPhase wait-status 带字节数", explainPhase({ phase: "wait-status", trace: { sentBytes: 88 } }).includes("88 字节"));
	check("explainPhase closed", explainPhase({ phase: "closed" }).includes("对端"));
	check("explainPhase done", explainPhase({ phase: "done" }).includes("正常吐字"));
	check("explainPhase 未知返回空串", explainPhase({ phase: "nope" }) === "");
	check("explainPhase undefined 不崩", explainPhase(undefined) === "");

	// ---------------------------------------------------------------- happy
	section("健康线路");
	{
		const { result, events } = await silentProbe({ base: mock.base, model: "fast-model", rounds: 3 });
		check("整体可用", result.ok === true, JSON.stringify(result.verdict));
		check("自动选中 fast-model", result.config.model === "fast-model" && result.config.modelAuto === false);
		const netRows = result.stages.network.checks;
		check("网络固定三行", netRows.length === 3, JSON.stringify(netRows.map((c) => c.id)));
		check("DNS 与 TCP 通过", netRows[0].status === "ok" && netRows[1].status === "ok");
		// mock 是 http 明文地址，TLS 行应为 skip 而不是 ok。
		check("http 下面 TLS 标为跳过", netRows[2].status === "skip", netRows[2].status);
		check("鉴权用 Bearer", result.stages.auth.scheme === "bearer");
		check("TTFT 落在 30-300ms", result.metrics.ttftMedian >= 30 && result.metrics.ttftMedian < 300, String(result.metrics.ttftMedian));
		check("tok/s > 45", result.metrics.tpsMedian > 45, String(result.metrics.tpsMedian?.toFixed(1)));
		check("成功率 100%", result.metrics.successRate === 1);
		check("评级 good", result.metrics.ttftGrade === "good" && result.metrics.tpsGrade === "good");
		check("结论是好用", result.verdict.level === "good" && result.verdict.headline.includes("好用"));
		check("事件流含四个阶段", ["network", "auth", "probe", "speed"].every((s) => events.some((e) => e.type === "stage" && e.stage === s)));
		// runProbe 自己发到 metrics 为止；HTTP 路由层在末尾再补一条 result。
		check("runProbe 事件流以 metrics 收尾", events[events.length - 1].type === "metrics", events[events.length - 1].type);
		check("Key 已打码", result.config.keyMasked.includes("****") && !JSON.stringify(result).includes(KEY), result.config.keyMasked);
	}

	section("自动选模型");
	{
		const { result } = await silentProbe({ base: mock.base, model: "", rounds: 1 });
		check("跳过 embedding 选中 gpt-4o-mini", result.config.model === "gpt-4o-mini", result.config.model);
		check("标记为自动挑选", result.config.modelAuto === true);
	}

	// ---------------------------------------------------------------- slow
	section("慢速线路");
	{
		const { result } = await silentProbe({ base: mock.base, model: "slow-model", rounds: 2 });
		check("仍判可用", result.ok === true);
		check("TTFT > 1000ms", result.metrics.ttftMedian > 1000, String(result.metrics.ttftMedian));
		check("TTFT 评级 slow", result.metrics.ttftGrade === "slow", result.metrics.ttftGrade);
		check("结论提到慢", result.verdict.level !== "good" && result.verdict.reasons.join(" ").includes("等"), JSON.stringify(result.verdict));
	}

	// ---------------------------------------------------------------- flaky
	section("不稳定线路");
	{
		const { result } = await silentProbe({ base: mock.base, model: "flaky-model", rounds: 6, concurrency: 1 });
		check("成功率不足 100%", result.metrics.successRate < 1, String(result.metrics.successRate));
		check("整体判为不可用", result.ok === false, result.verdict.headline);
		check("结论是不建议上生产", result.verdict.level === "bad" && result.verdict.headline.includes("不建议"));
		check("失败原因被记录", result.stages.speed.failures.length >= 1, JSON.stringify(result.stages.speed.failures));
	}

	// ---------------------------------------------------------------- auth
	section("鉴权与地址");
	{
		const { result } = await silentProbe({ base: mock.base, key: "wrong-key", model: "fast-model" });
		check("错 Key 判不可用", result.ok === false);
		check("结论指出 Key 无效", result.stages.auth.diagnosis?.title === "Key 无效", JSON.stringify(result.stages.auth.diagnosis));
		check("未进入速度阶段", result.stages.speed === null);
	}
	{
		// A bare host is auto-completed by normBase() at the route entry
		// (lib/index.js), so "missing /v1" is not reachable through the HTTP API —
		// the guard exists for direct diagnose() callers. This case asserts the
		// completion itself works against the mock.
		const { result } = await silentProbe({ base: mock.base.replace("/v1", ""), model: "fast-model" });
		check("裸域名被自动补 /v1 后仍可用", result.stages.auth?.ok === true, JSON.stringify(result.stages.auth?.diagnosis));
		check("补全后请求命中 /v1/models", result.stages.auth?.checks?.[0]?.status === "ok");
	}
	{
		const { result } = await silentProbe({ base: "", key: KEY });
		check("空地址有明确报错", result.ok === false && result.error.includes("API 地址"), result.error);
	}
	{
		const { result } = await silentProbe({ base: "ftp://x.cn", key: KEY });
		check("非 http 协议被拦", result.ok === false && result.error.includes("http"), result.error);
	}

	// ---------------------------------------------------------------- payload
	section("模型名拼错时立刻提示");
	{
		// The provider already told us what it offers; a name it does not have
		// should be flagged here, not surface later as an opaque 400.
		const { result, events } = await silentProbe({ base: mock.base, model: "gpt-4o-mimi", rounds: 1 });
		const notice = result.stages.modelNotice ?? "";
		check("给出手写模型名不在列表的提示", typeof notice === "string" && notice.includes("可能拼错了"), notice);
		check("提示里带上服务商的正确写法", notice.includes("gpt-4o-mini"), notice);
		check("提示通过 model 事件下发", events.some((e) => e.type === "model" && typeof e.notice === "string" && e.notice.includes("可能拼错了")), JSON.stringify(events.find((e) => e.type === "model")));
		check("手写模型不被自动替换", result.stages.model === "gpt-4o-mimi");
		check("手写模型不算自动挑选", result.stages.modelAuto === false);
	}
	{
		// gpt-4o-mini is one of the three the mock actually lists — no warning.
		const { result } = await silentProbe({ base: mock.base, model: "gpt-4o-mini", rounds: 1 });
		check("列表里有的模型名不误报", result.stages.modelNotice === null, JSON.stringify(result.stages.modelNotice));
	}
	{
		// The mock serves fast-model but omits it from /models. That is exactly the
		// real-world case of an incomplete model list, so the probe must still run
		// and only warn — never block on a listing the provider may have trimmed.
		const { result } = await silentProbe({ base: mock.base, model: "fast-model", rounds: 1 });
		check("未列出的模型仍照常检测", result.stages.sample.ok === true, JSON.stringify(result.verdict));
		check("未列出的模型给出警告", (result.stages.modelNotice ?? "").includes("可能拼错了"), JSON.stringify(result.stages.modelNotice));
	}
	{
		const { result } = await silentProbe({ base: mock.base, rounds: 1 });
		check("自动挑的模型不报拼错", result.stages.modelAuto === true && result.stages.modelNotice === null, JSON.stringify(result.stages.modelNotice));
	}

	section("服务商特有响应");
	{
		const { result } = await silentProbe({ base: mock.base, model: "ratelimit", rounds: 1 });
		check("429 判不可用", result.ok === false);
		check("429 提示是限流或欠费", result.stages.sample.diagnosis?.title.includes("限流"), JSON.stringify(result.stages.sample.diagnosis));
		check("429 说明了 Key 是对的", result.stages.sample.diagnosis?.detail.includes("429"));
	}
	{
		const { result } = await silentProbe({ base: mock.base, model: "empty-model", rounds: 1 });
		check("空内容判不可用", result.ok === false);
		check("空内容有专属说明", result.stages.sample.diagnosis?.detail.includes("一个字的正文"), JSON.stringify(result.stages.sample.diagnosis));
	}

	// ---------------------------------------------------------------- network
	section("网络故障");
	{
		const { result } = await silentProbe({ base: "http://127.0.0.1:1/v1", key: KEY, timeout: 3000 });
		check("端口不通判不可用", result.ok === false);
		check("TCP 检查标记 fail", result.stages.network.checks.find((c) => c.id === "tcp")?.status === "fail");
		check("TLS 被跳过而非误判", result.stages.network.checks.find((c) => c.id === "tls")?.status === "skip");
		check("结论停在网络层", result.verdict.headline.includes("网络"), result.verdict.headline);
	}
	{
		const { result } = await silentProbe({ base: "https://this-host-does-not-exist-xyz.invalid/v1", key: KEY, timeout: 4000 });
		check("DNS 失败判不可用", result.ok === false);
		check("DNS 检查标记 fail", result.stages.network.checks[0].status === "fail");
	}
	{
		const { result } = await silentProbe({ base: "https://127.0.0.1:1/v1", key: KEY, timeout: 3000 });
		check("http 明文地址跳过 TLS", result.stages.network.checks.find((c) => c.id === "tls")?.status === "skip");
	}

	// ------------------------------------------------- request phase (the point)
	// Two servers that fail in opposite directions: one takes the bytes and goes
	// silent, one hangs up without answering. The probe must tell them apart and,
	// for the silent one, admit the request was sent.
	section("请求卡在哪一步");
	{
		// /models answers normally so the probe gets past auth; only the chat call
		// stalls — otherwise the run stops at the auth stage and never reaches it.
		const listBody = JSON.stringify({ data: [{ id: "gpt-4o-mini" }] });
		const silent = http.createServer((req, res) => {
			req.resume();
			if (req.url.endsWith("/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(listBody);
				return;
			}
			// deliberately never respond
		});
		await new Promise((r) => silent.listen(0, "127.0.0.1", r));
		const port = silent.address().port;
		try {
			const { result } = await silentProbe({ base: `http://127.0.0.1:${port}/v1`, key: KEY, timeout: 3000, rounds: 1 });
			check("吞掉请求的服务端判不可用", result.ok === false);
			check("卡在等服务端回状态", result.stages.sample.phase === "wait-status", String(result.stages.sample.phase));
			check("承认请求已写出", (result.stages.sample.trace?.sentBytes ?? 0) > 0, String(result.stages.sample.trace?.sentBytes));
			check("结论不谎称没调用", result.verdict.headline.includes("发出去了"), result.verdict.headline);
			check("结论明确请求已发出", result.verdict.reasons.some((r) => r.includes("已经发出去了")), JSON.stringify(result.verdict.reasons));
		} finally {
			silent.closeAllConnections?.();
			await new Promise((r) => silent.close(r));
		}
	}
	{
		const rude = http.createServer((req, res) => {
			req.resume();
			if (req.url.endsWith("/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }));
				return;
			}
			req.socket.destroy();
		});
		await new Promise((r) => rude.listen(0, "127.0.0.1", r));
		const port = rude.address().port;
		try {
			const { result } = await silentProbe({ base: `http://127.0.0.1:${port}/v1`, key: KEY, timeout: 3000, rounds: 1 });
			check("被对端掐断判不可用", result.ok === false);
			const phase = result.stages.sample.phase;
			check("识别出对端直接断连", phase === "closed" || phase === "write", String(phase));
			check("断连不是超时的锅", result.stages.sample.diagnosis?.title.includes("断") || result.stages.sample.diagnosis?.title.includes("写"), result.stages.sample.diagnosis?.title);
		} finally {
			rude.closeAllConnections?.();
			await new Promise((r) => rude.close(r));
		}
	}

	// ---------------------------------------------------------------- perf
	section("配置边界");
	{
		const { result } = await silentProbe({ base: mock.base, model: "fast-model", rounds: 2, concurrency: 2 });
		check("并发 2 能跑通", result.ok === true);
		check("仍然只记 2 次", result.metrics.attempts === 2);
	}
} finally {
	await mock.close();
}

console.log("\n" + "─".repeat(52));
if (failures.length === 0) {
	console.log(`全部通过：${passed} 项`);
	process.exit(0);
}
console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
for (const failure of failures) console.log("  · " + failure);
process.exit(1);