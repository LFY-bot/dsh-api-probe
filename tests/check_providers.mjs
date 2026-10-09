/**
 * Re-check every PRESETS base URL against the live vendor endpoint.
 *
 * Why this exists
 * ---------------
 * A preset base URL is the one piece of the list that cannot be derived from the
 * vendor — someone has to know it. Vendors also move hosts without announcing
 * it, so a URL that was correct at release time rots silently: the dropdown
 * still offers it, the user picks it, and the probe reports "地址不对" against a
 * vendor that was never wrong. That failure is indistinguishable from a typo in
 * the user's own key, which is the worst kind to debug.
 *
 * The preset list deliberately ships no model IDs for exactly the same reason —
 * vendor-controlled strings rot, and we would be shipping rot. This script is
 * the equivalent safety net for the one vendor-controlled string we must ship.
 *
 * Usage
 * -----
 *   node tests/check_providers.mjs                  # offline: validate + print the list
 *   node tests/check_providers.mjs --online         # also probe every endpoint
 *   node tests/check_providers.mjs --online --only=xfeng,deepseek
 *
 * `--only` takes a comma-separated list of preset ids. Useful for spot-checking
 * a handful of vendors without firing a request at all 37 — some gateways
 * rate-limit or flag bursts of unauthenticated traffic from one source, and a
 * full sweep is not something to run casually.
 *
 * No API key is sent or needed. We ask for `/models` with no credentials, so:
 *
 *   200            the endpoint is open and the base URL is right
 *   401 / 403      the endpoint is alive but gated — base URL is right, key needed
 *   404            the base URL is wrong (a wrong path segment lands here)
 *   405            the path exists but refuses GET — also fine, base URL is right
 *   anything else  reported verbatim; treat as "needs a human look"
 *
 * Exit code is non-zero when any preset looks wrong, so this can gate CI or a
 * release checklist. Offline mode always exits 0 unless the list is malformed.
 *
 * `--online` needs outbound network. Behind a corporate firewall or a region
 * block, expect UNREACHABLE for every vendor — that is an environment fact,
 * not a defect in the list, so read the two columns together before editing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const ONLINE = process.argv.includes("--online");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7)
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 8000);
const CONCURRENCY = 6;

/**
 * Same extraction the client suite uses, and for the same reason: PRESETS is a
 * pure data literal, so evaluate it rather than pattern-matching the text.
 * The capture must stop at the array's own `]` and not require a `;` — the
 * list ends in `.sort(...)`, and anchoring on `];` silently yields null, which
 * reads as an empty list instead of an error.
 */
const literal = clientSrc.match(/const PRESETS = (\[[\s\S]*?\n\t\t\])/);
if (!literal) {
	console.error(
		"[x] 无法从 lib/client.js 提取 PRESETS 字面量。\n" +
		"    结构可能变了（例如数组结尾不再以 `\\n\\t\\t]` 收尾）。\n" +
		"    请同步修正本脚本和 tests/run_client_tests.mjs 里的同一处正则。"
	);
	process.exit(2);
}
const sandbox = { Array, Set, JSON };
vm.createContext(sandbox);
vm.runInContext("globalThis.__P = " + literal[1], sandbox);
const presets = sandbox.__P;

// Validate the --only filter before anything else: a typo in an id must fail
// loudly in both modes, not silently probe zero endpoints and exit 0.
if (ONLY.length) {
	const unknown = ONLY.filter((id) => !presets.some((p) => p.id === id));
	if (unknown.length) {
		console.error(`[x] --only 里有不存在的 id：${unknown.join(", ")}`);
		console.error("    可用 id 见上方列表。");
		process.exit(2);
	}
}

/* ------------------------------- validation ------------------------------- */

const problems = [];
const seen = { id: new Map(), base: new Map() };

for (const p of presets) {
	if (seen.id.has(p.id)) problems.push(`重复的 id：${p.id}`);
	seen.id.set(p.id, true);

	const key = p.base.toLowerCase();
	if (key && seen.base.has(key)) problems.push(`重复的地址：${p.base}（${seen.base.get(key)} 与 ${p.id}）`);
	seen.base.set(key, p.id);

	if (p.base && !/^https?:\/\//.test(p.base)) problems.push(`${p.id} 的地址没有协议：${p.base}`);
	if (p.model !== "") problems.push(`${p.id} 预填了模型名（应由 /models 决定）`);
	if (!Array.isArray(p.hints) || p.hints.length) problems.push(`${p.id} 的 hints 非空`);
	if (!["openai", "anthropic", "gemini"].includes(p.api)) problems.push(`${p.id} 的 api 取值非法：${p.api}`);
}

if (!presets.length) problems.push("PRESETS 是空的——提取到的很可能不是列表本身");

console.log(`\nPRESETS：${presets.length} 条\n${"─".repeat(72)}`);
for (const p of presets) {
	const note = !p.base ? "（空，用户自填）" : /你的账户|你的|<.*>/.test(p.base) ? "（模板，需替换）" : /localhost|127\.0\.0\.1/.test(p.base) ? "（本地）" : "";
	console.log(`${p.id.padEnd(20)}${p.api.padEnd(11)}${p.base}${note ? "  " + note : ""}`);
}
console.log(`${"─".repeat(72)}`);

if (problems.length) {
	console.log("\n结构问题：");
	for (const m of problems) console.log(`  [x] ${m}`);
} else {
	console.log("结构检查：无问题");
}

if (!ONLINE) {
	console.log(
		ONLY.length
			? `\n（离线模式，未发起任何网络请求。加 --online --only=${ONLY.join(",")} 抽检这几条。）\n`
			: "\n（离线模式，未发起任何网络请求。加 --online 逐个核对地址。）\n"
	);
	process.exit(problems.length ? 1 : 0);
}

/* --------------------------------- online --------------------------------- */

let targets = presets.filter((p) => p.base && !/你的账户|你的|<.*>/.test(p.base));
if (ONLY.length) {
	targets = targets.filter((p) => ONLY.includes(p.id));
}
console.log(`\n在线核对 ${targets.length} 条（每条 ${TIMEOUT_MS}ms 超时，并发 ${CONCURRENCY}）…\n`);

/** Verdict -> does the base URL look wrong? */
function verdictFor(status) {
	if (status >= 200 && status < 300) return ["OK", false, ""];
	if (status === 401 || status === 403) return ["AUTH", false, "端点存在，需要 Key"];
	if (status === 404) return ["MISSING", true, "路径不对：base 多半写错了"];
	if (status === 405) return ["OK", false, "路径存在，不接受 GET"];
	return ["OTHER", true, "非预期状态码"];
}

async function check(p) {
	const url = p.base.replace(/\/+$/, "") + "/models";
	try {
		const res = await fetch(url, {
			method: "GET",
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: { accept: "application/json", "user-agent": "dsh-api-probe-check" },
		});
		const [tag, bad, note] = verdictFor(res.status);
		return { id: p.id, url, tag, bad, note: note || `HTTP ${res.status}` };
	} catch (err) {
		const msg = String(err?.message ?? err);
		// Distinguish "the network refused" from "this host does not exist":
		// the first is an environment fact, the second is a real defect.
		const dns = /getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(msg);
		const refused = /ECONNREFUSED/i.test(msg);
		const tag = dns ? "UNRESOLVED" : refused ? "UNREACHABLE" : "TIMEOUT";
		const hint = dns ? "域名解析不了" : refused ? "连不上" : "超时或 TLS 失败";
		return { id: p.id, url, tag, bad: dns, note: `${hint}：${msg.slice(0, 80)}` };
	}
}

const results = [];
let cursor = 0;
await Promise.all(
	Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
		while (cursor < targets.length) {
			const r = await check(targets[cursor++]);
			results.push(r);
			const mark = r.bad ? "x" : "v";
			console.log(`  [${mark}] ${r.id.padEnd(20)}${r.tag.padEnd(11)}${r.note}`);
		}
	})
);

const byTag = results.reduce((acc, r) => ((acc[r.tag] = (acc[r.tag] ?? 0) + 1), acc), {});
console.log(`\n汇总：${Object.entries(byTag).map(([k, v]) => `${k}=${v}`).join("  ")}`);

const bad = results.filter((r) => r.bad);
if (bad.length) {
	console.log("\n需要人工确认：");
	for (const r of bad) console.log(`  [x] ${r.id.padEnd(20)}${r.url}\n      ${r.note}`);
	console.log("\nUNREACHABLE / TIMEOUT 多半是本机网络或区域限制，不等于地址写错；");
	console.log("MISSING / UNRESOLVED 才值得去改 PRESETS —— 改之前先找官方文档核对。");
}
console.log();
process.exit(problems.length || bad.length ? 1 : 0);