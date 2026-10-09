/**
 * Route-level tests: drive the actual webServer handlers registered by
 * `apply`, not just `runProbe`.
 *
 * These exist because the unit suite cannot see context-wiring bugs — a
 * top-level route list closing over a `ctx` that only exists inside apply()
 * loads cleanly and throws ReferenceError on the first real request.
 */

import { Readable } from "node:stream";
import { startMockApi, KEY } from "./mock_api.js";
import { apply } from "../lib/index.js";

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

/** Minimal cordis-shaped ctx that captures whatever apply() registers. */
function fakeCtx() {
	const registered = [];
	return {
		registered,
		logger: { warn: (e) => console.error("warn:", e) },
		webServer: { register: (route) => { registered.push(route); return () => {}; } },
		effect: (fn, label) => { fn(); return () => {}; },
	};
}

function fakeReq(body, overrides = {}) {
	const req = new Readable({ read() {} });
	req.push(body === undefined ? "" : body);
	req.push(null);
	req.method = overrides.method ?? "POST";
	req.headers = { host: "127.0.0.1:19387", ...(overrides.headers ?? {}) };
	req.socket = { remoteAddress: overrides.remoteAddress ?? "127.0.0.1" };
	return req;
}

function fakeRes() {
	const res = {
		statusCode: null,
		headers: null,
		chunks: [],
		ended: false,
		writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
		write(chunk) { res.chunks.push(String(chunk)); },
		end(chunk) { if (chunk !== undefined) res.chunks.push(String(chunk)); res.ended = true; },
	};
	return res;
}

function ndjson(res) {
	return res.chunks
		.join("")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

const mock = await startMockApi(0);

try {
	console.log("路由注册");
	const ctx = fakeCtx();
	apply(ctx, {});
	check("注册了两条路由", ctx.registered.length === 2, String(ctx.registered.length));
	const paths = ctx.registered.map((r) => r.path).sort();
	check("路由路径正确", JSON.stringify(paths) === JSON.stringify(["/api/dsh-api-probe/health", "/api/dsh-api-probe/probe"]), JSON.stringify(paths));
	check("两条都是 exact", ctx.registered.every((r) => r.kind === "exact"));
	check("handler 都是函数", ctx.registered.every((r) => typeof r.handler === "function"));

	const probe = ctx.registered.find((r) => r.path.endsWith("/probe"));
	const health = ctx.registered.find((r) => r.path.endsWith("/health"));

	console.log("\n健康检查");
	{
		const res = fakeRes();
		await health.handler(fakeReq(undefined, { method: "GET" }), res);
		check("health 返回 200", res.statusCode === 200, String(res.statusCode));
		const body = JSON.parse(res.chunks.join(""));
		check("health 自报 plugin 名", body.plugin === "api-probe", JSON.stringify(body));
	}
	{
		const res = fakeRes();
		await health.handler(fakeReq(undefined, { method: "POST" }), res);
		check("health 拒绝非 GET", res.statusCode === 405, String(res.statusCode));
	}

	console.log("\n信任栅栏");
	{
		const res = fakeRes();
		await probe.handler(fakeReq(JSON.stringify({ base: mock.base, key: KEY }), { remoteAddress: "10.0.0.5" }), res);
		check("非本机来源被拒", res.statusCode === 403, String(res.statusCode));
	}
	{
		const res = fakeRes();
		await probe.handler(fakeReq(JSON.stringify({ base: mock.base, key: KEY }), { headers: { host: "evil.example.com" } }), res);
		check("Host 头不指向本机被拒", res.statusCode === 403, String(res.statusCode));
	}
	{
		const res = fakeRes();
		await probe.handler(fakeReq(JSON.stringify({ base: mock.base, key: KEY }), { headers: { "sec-fetch-site": "cross-site" } }), res);
		check("cross-site 被拒", res.statusCode === 403, String(res.statusCode));
	}
	{
		const res = fakeRes();
		await probe.handler(fakeReq(JSON.stringify({ base: mock.base, key: KEY }), { headers: { origin: "http://evil.example.com" } }), res);
		check("跨源 Origin 被拒", res.statusCode === 403, String(res.statusCode));
	}
	{
		const res = fakeRes();
		await probe.handler(fakeReq(JSON.stringify({ base: mock.base, key: KEY }), { method: "GET" }), res);
		check("probe 拒绝非 POST", res.statusCode === 405, String(res.statusCode));
	}
	{
		const res = fakeRes();
		await probe.handler(fakeReq("x".repeat(70 * 1024)), res);
		check("超大 body 被拒", res.statusCode === 400 || res.statusCode === 413, String(res.statusCode));
	}

	console.log("\nNDJSON 流");
	{
		const res = fakeRes();
		await probe.handler(
			fakeReq(JSON.stringify({ base: mock.base, key: KEY, model: "fast-model", rounds: 2, timeout: 10 })),
			res,
		);
		check("probe 返回 200", res.statusCode === 200, String(res.statusCode));
		check("响应是 NDJSON", String(res.headers?.["content-type"]).includes("x-ndjson"), JSON.stringify(res.headers));
		check("禁掉了代理缓冲", res.headers?.["x-accel-buffering"] === "no");
		const events = ndjson(res);
		check("事件流以 result 收尾", events[events.length - 1]?.type === "result", events[events.length - 1]?.type);
		check("result.ok 为真", events[events.length - 1]?.result?.ok === true, JSON.stringify(events[events.length - 1]?.result?.verdict));
		check("四个阶段都在", ["network", "auth", "probe", "speed"].every((s) => events.some((e) => e.type === "stage" && e.stage === s)));
		check("metrics 事件带评级", events.some((e) => e.type === "metrics" && e.ttftGrade && e.tpsGrade && e.rateGrade));
		check("整条流里没有明文 Key", !res.chunks.join("").includes(KEY));
		check("响应已正常结束", res.ended === true);
	}

	console.log("\n异常输入");
	{
		const res = fakeRes();
		await probe.handler(fakeReq("not json"), res);
		check("坏 JSON 直接 400，不进探测", res.statusCode === 400, String(res.statusCode));
	}
	{
		const res = fakeRes();
		await probe.handler(fakeReq(JSON.stringify(["数组不是对象"])), res);
		check("非对象 JSON 被拒", res.statusCode === 400, String(res.statusCode));
	}
	{
		const res = fakeRes();
		await probe.handler(fakeReq(JSON.stringify({ base: "", key: "" })), res);
		const result = ndjson(res).pop().result;
		check("空输入不崩", result.ok === false && typeof result.error === "string", JSON.stringify(result));
	}
	{
		const res = fakeRes();
		await probe.handler(fakeReq(JSON.stringify({ base: mock.base, key: KEY, rounds: 9999 })), res);
		const result = ndjson(res).pop().result;
		check("越界 rounds 被夹住", result.ok === true && result.metrics.attempts <= 10, String(result.metrics?.attempts));
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