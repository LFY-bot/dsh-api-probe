/**
 * 客户端模块契约测试。
 *
 * 这个测试是为一个真实的线上事故写的：lib/client.js 的工厂只往 `exports`
 * 上赋值却没有 return，加载器拿到 undefined，整个 Web shell 启动即崩，而且
 * 报错信息里没有任何插件名字。下面直接模拟 `window.__ModuleLoader__` 的行为
 * ——「调用 factory，把返回值当作插件模块」——来锁住这个契约。
 *
 * 运行: node tests/run_client_tests.mjs
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "lib", "client.js");

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

/** 足够驱动模块顶层求值的 React 桩：组件只在渲染时才被调用，这里用不到。 */
function reactStub() {
	const noop = () => {};
	return {
		createElement: (...args) => ({ type: args[0], props: args[1], kids: args.slice(2) }),
		useState: (init) => [typeof init === "function" ? init() : init, noop],
		useEffect: noop,
		useRef: () => ({ current: null }),
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn,
	};
}

/** 按真实加载器的方式加载 client.js：调用 factory，取返回值作为模块。 */
function loadClientModule() {
	const registrations = [];
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(spec) {
					registrations.push(spec);
				},
			},
		},
		console,
		setTimeout,
		clearTimeout,
		AbortController,
		TextDecoder,
		JSON,
		Math,
		Date,
		Promise,
		Error,
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	const source = fs.readFileSync(CLIENT, "utf8");
	vm.runInContext(source, sandbox, { filename: "client.js" });
	return { registrations, sandbox };
}

console.log("客户端模块契约");
const { registrations, sandbox } = loadClientModule();

check("向加载器注册了一次", registrations.length === 1, String(registrations.length));

const spec = registrations[0] ?? {};
check("id 等于包名 dsh-api-probe", spec.id === "dsh-api-probe", String(spec.id));
check("提供了 factory", typeof spec.factory === "function", typeof spec.factory);

console.log("\n工厂返回值");
let mod = null;
try {
	mod = spec.factory((name) => {
		if (name === "react") return reactStub();
		if (name === "react/jsx-runtime") return { jsx: () => {}, jsxs: () => {} };
		throw new Error("插件只应 require react / react/jsx-runtime，却请求了 " + name);
	});
} catch (e) {
	check("工厂能执行不抛错", false, String(e && e.message));
}

if (mod != null) {
	check("工厂返回了模块对象（崩溃根因）", typeof mod === "object", String(mod));
	check("导出了 apply", typeof mod?.apply === "function", typeof mod?.apply);
	check("导出了 inject 数组", Array.isArray(mod?.inject), JSON.stringify(mod?.inject));
	check("inject 声明了 slots/locale/layout", ["slots", "locale", "layout"].every((k) => (mod?.inject ?? []).includes(k)), JSON.stringify(mod?.inject));
}

console.log("\n兜底保护");
{
	// The loader has no per-plugin guard, so an escaping throw kills the whole
	// shell. Force an internal failure and require a usable module anyway.
	let degraded = undefined;
	let threw = null;
	try {
		degraded = spec.factory(() => {
			throw new Error("模拟 react 加载失败");
		});
	} catch (e) {
		threw = e;
	}
	check("内部故障不会逃逸出工厂", threw === null, String(threw && threw.message));
	check("降级为可用的空模块", typeof degraded === "object" && degraded !== null, String(degraded));
	check("降级模块的 apply 可调用", typeof degraded?.apply === "function");
	check("降级模块的 inject 是数组", Array.isArray(degraded?.inject));
	let degradedApplyThrew = null;
	try {
		degraded?.apply({});
	} catch (e) {
		degradedApplyThrew = e;
	}
	check("降级模块的 apply 空跑不抛错", degradedApplyThrew === null, String(degradedApplyThrew && degradedApplyThrew.message));
}

console.log("\napply 健壮性");
if (typeof mod?.apply === "function") {
	// slots.inject 只在对应 seat 被声明后才回调；先记录再手动触发。
	const registered = [];
	const pending = [];
	const ctx = {
		slots: {
			inject(seat, fn) {
				pending.push({ seat, fn });
				return () => {
					const at = pending.findIndex((p) => p.fn === fn);
					if (at >= 0) pending.splice(at, 1);
				};
			},
			register(options, component) {
				registered.push({ options, component });
				return () => {
					const at = registered.findIndex((r) => r.options === options);
					if (at >= 0) registered.splice(at, 1);
				};
			},
		},
		locale: {
			register: () => () => {},
			bind: () => (key) => key,
		},
		effect(fn) {
			fn();
			return () => {};
		},
		get: () => undefined,
	};

	try {
		mod.apply(ctx);
		check("apply 不抛错", true);
	} catch (e) {
		check("apply 不抛错", false, String(e && e.stack ? e.stack.split("\n")[0] : e));
	}

	check("等了两个 seat", pending.length === 2, pending.map((p) => p.seat).join(", "));
	check("seat 是 sidebar.panellist 与 main", pending.some((p) => p.seat === "sidebar.panellist") && pending.some((p) => p.seat === "main"));

	for (const p of [...pending]) p.fn();
	check("两个面板都注册成功", registered.length === 2, String(registered.length));
	const sidebar = registered.find((r) => r.options.name === "sidebar.panellist");
	const main = registered.find((r) => r.options.name === "main");
	check("侧栏项带 id/order/label", Boolean(sidebar && sidebar.options.id && typeof sidebar.options.order === "number" && typeof sidebar.options.label === "function"), JSON.stringify(sidebar?.options));
	check("主页面用 key 绑定", Boolean(main && main.options.key === sidebar?.options.id), JSON.stringify(main?.options));
	check("主页面组件是函数", typeof main?.component === "function");
}

console.log("\n构建期硬错误");
const clientSrc = fs.readFileSync(CLIENT, "utf8");
check("没有裸 JSX 残留", /\bReact\.createElement\b|const el =/.test(clientSrc));
check("路由是文档相对路径", clientSrc.includes('probe: "api/dsh-api-probe/probe"'));

// The harness serves the GUI with <base href="./">, so a root-absolute fetch
// target escapes the deployment prefix. Scan every fetch() argument instead of
// trusting one regex — and name the offender when it trips.
const fetchArgs = [...clientSrc.matchAll(/fetch\(\s*(["'])([^"']*)\1/g)].map((m) => m[2]);
check("没有写死的 fetch 地址", fetchArgs.length === 0, "写死了: " + fetchArgs.join(", "));
check("fetch 目标来自 API 常量（相对路径）", /fetch\(\s*API\./.test(clientSrc));

console.log("\n文案完整性");
// A key used with tt() but missing from a dictionary renders as the raw key
// string on screen. The zh/en dictionaries are two separate literal objects, so
// adding a zh entry and forgetting en is easy and invisible in review.
const dictBlocks = [...clientSrc.matchAll(/const (zh|en)\s*=\s*\{([\s\S]*?)\n\t*\};/g)];
const dictKeys = {};
for (const [, lang, body] of dictBlocks) {
	dictKeys[lang] = new Set([...body.matchAll(/"([a-zA-Z][\w.]*)":/g)].map((m) => m[1]));
}
check("找到 zh 与 en 两份字典", Boolean(dictKeys.zh) && Boolean(dictKeys.en), Object.keys(dictKeys).join(", "));
const usedKeys = [...new Set([...clientSrc.matchAll(/\btt\("([^"]+)"/g)].map((m) => m[1]))];
check("至少用到 10 个文案键", usedKeys.length >= 10, String(usedKeys.length));
const missingZh = usedKeys.filter((k) => !dictKeys.zh?.has(k));
const missingEn = usedKeys.filter((k) => !dictKeys.en?.has(k));
check("所有用到的键在中文词典里都有", missingZh.length === 0, "缺: " + missingZh.join(", "));
check("所有用到的键在英文词典里都有", missingEn.length === 0, "缺: " + missingEn.join(", "));
const zhOnly = [...(dictKeys.zh ?? [])].filter((k) => !dictKeys.en?.has(k));
const enOnly = [...(dictKeys.en ?? [])].filter((k) => !dictKeys.zh?.has(k));
check("中英词典没有单边键", zhOnly.length === 0 && enOnly.length === 0, "仅中文: " + zhOnly.join(", ") + " / 仅英文: " + enOnly.join(", "));

console.log("\n禁用按钮的观感");
// A dimmed brand fill on a dark theme reads as a washed-out grey lump. Assert the
// disabled state is an outline instead, so a regression here is visible in tests.
const btnRules = clientSrc.match(/\.dshap-btn:disabled\{[^}]*\}/g) ?? [];
check("有禁用态样式", btnRules.length === 1, String(btnRules.length));
check("禁用态不再整体降透明", !/opacity:\s*\.[0-9]/.test(btnRules[0] ?? ""), btnRules[0]);
check("禁用态是空心描边", /background:\s*transparent/.test(btnRules[0] ?? "") && /border-color/.test(btnRules[0] ?? ""), btnRules[0]);
check("禁用时说明为什么不能点", clientSrc.includes('tt("foot.needInput")'));
check("按钮 title 也解释禁用原因", /title:\s*form\.base\.trim\(\)/.test(clientSrc));

console.log("\n模型名引导");
{
	// Regression: the host emits `models`, the card read `names`, so the list of
	// models the provider actually offers has never rendered.
	check("模型列表卡片读的是 models 字段", clientSrc.includes("modelsEvent.models"));
	check("不再读不存在的 names 字段", !clientSrc.includes("modelsEvent.names"));

	const picker = sandbox.chatModelNames;
	check("chatModelNames 可用", typeof picker === "function", typeof picker);
	const picked = picker(["gpt-4o-mini", "text-embedding-3-small", "deepseek-chat", "bge-reranker-v2"], 10);
	check("过滤掉 embedding 等非对话模型", !picked.includes("text-embedding-3-small") && !picked.includes("bge-reranker-v2"), JSON.stringify(picked));
	check("对话模型排在前面", picked[0] === "deepseek-chat" && picked[1] === "gpt-4o-mini", JSON.stringify(picked));
	check("去重", picker(["a", "a", "b"], 10).length === 2);
	check("尊重条数上限", picker(["m1", "m2", "m3", "m4"], 2).length === 2);
	check("非数组输入安全", Array.isArray(picker(undefined, 5)) && picker(undefined, 5).length === 0);
	// An all-embedding provider must still show something, otherwise the chip row
	// silently vanishes and the user never learns why no model was picked.
	check("对方只有非对话模型时不至于空白", JSON.stringify(picker(["text-embedding-3-small"], 5)) === JSON.stringify(["text-embedding-3-small"]));

	// PRESETS is a pure data literal — extract and evaluate it for real rather
	// than pattern-matching the source text. The capture must stop at the array's
	// own closing bracket, NOT require a semicolon: the list ends in `.sort(...)`
	// to keep its order deterministic, and anchoring on `];` silently disabled
	// every assertion below (a null literal skips the whole block, which reads as
	// "passing" while checking nothing).
	const literal = clientSrc.match(/const PRESETS = (\[[\s\S]*?\n\t\t\])/);
	check("能取出 PRESETS 字面量", Boolean(literal));
	if (!literal) {
		// Fail loudly instead of skipping. A silently-skipped block reports zero
		// failures and reads as green, so a one-character change to the source
		// (adding `.sort(...)`, say) can quietly retire every assertion in here.
		check("PRESETS 断言实际执行过（非跳过）", false, "字面量提取失败，块内所有检查均未运行");
	} else {
		const probeSandbox = { Array, Set, JSON };
		vm.createContext(probeSandbox);
		vm.runInContext("globalThis.__P = " + literal[1], probeSandbox);
		const presets = probeSandbox.__P;
		const byId = new Map(presets.map((p) => [p.id, p]));
		check("有商汤预设（用户实际在用的）", byId.has("sensenova"), [...byId.keys()].join(", "));
		// The previous contract required each preset to ship hand-written model
		// names. That was the bug: model IDs churn daily and vendors disagree, so
		// a stale chip is misleading rather than helpful. The authority is now the
		// provider's own /models response, reached by leaving `model` blank.
		check("所有预设的 hints 都留空", presets.every((p) => p.hints.length === 0), JSON.stringify(presets.filter((p) => p.hints.length).map((p) => p.id)));
		check("所有预设的 model 都留空（改由自动探测）", presets.every((p) => p.model === ""), JSON.stringify(presets.filter((p) => p.model).map((p) => p.id)));
		check("hints 字段仍保留为数组", presets.every((p) => Array.isArray(p.hints)));

		// Provider coverage: base URLs only, and a usable spread of vendors.
		check("预设数量达到三十家以上", presets.length >= 30, String(presets.length));
		check("没有重复的 id", new Set(presets.map((p) => p.id)).size === presets.length);
		check("没有重复的地址", new Set(presets.map((p) => p.base)).size === presets.length);
		check("云端预设的地址都带协议", presets.filter((p) => p.base !== "").every((p) => /^https?:\/\//.test(p.base)), JSON.stringify(presets.filter((p) => p.base !== "" && !/^https?:\/\//.test(p.base)).map((p) => p.id)));
		check("协议取值合法", presets.every((p) => ["openai", "anthropic", "gemini"].includes(p.api)), JSON.stringify(presets.filter((p) => !["openai", "anthropic", "gemini"].includes(p.api)).map((p) => p.id)));
		check("自定义项在列表里且地址为空", presets.some((p) => p.id === "custom" && p.base === ""));

		// Ordering is a contract, not a preference: users scan this list. Two blocks that
		// never interleave — Chinese vendors by pinyin, then English by letter, then
		// the escape hatch. The key is ASCII so order never depends on the host's
		// ICU build.
		check("每条都有排序键", presets.every((p) => typeof p.sort === "string" && p.sort !== ""), JSON.stringify(presets.filter((p) => !p.sort).map((p) => p.id)));
		check("排序键没有重复（顺序稳定）", new Set(presets.map((p) => p.sort)).size === presets.length, JSON.stringify(presets.map((p) => p.sort).filter((s, i, a) => a.indexOf(s) !== i)));
		check("列表已按排序键升序", presets.every((p, i) => i === 0 || presets[i - 1].sort <= p.sort), JSON.stringify(presets.map((p) => p.sort)));
		check("自定义项固定在最末", presets[presets.length - 1].id === "custom");
		// A single interleaved key is what put 百川 between Baseten and Cerebras and
		// 火山引擎 after Hyperbolic. The blocks must stay contiguous.
		check("中文区在最前且连续", (() => {
			const isCn = (p) => p.sort.startsWith("cn");
			const first = presets.findIndex(isCn);
			const last = presets.findLastIndex(isCn);
			return first === 0 && presets.slice(first, last + 1).every(isCn);
		})(), JSON.stringify(presets.map((p) => p.id + ":" + p.sort)));
		check("英文区在中文区之后且连续", (() => {
			const isEn = (p) => p.sort.startsWith("en");
			const first = presets.findIndex(isEn);
			const last = presets.findLastIndex(isEn);
			return first > 0 && presets.slice(first, last + 1).every(isEn) && last === presets.length - 2;
		})(), JSON.stringify(presets.map((p) => p.id + ":" + p.sort)));
	}

	// Leaving it blank is now the RECOMMENDED path: it triggers the live /models
	// lookup, which is the only source that cannot be stale.
	check("引导用户留空以触发自动探测", /"form\.model\.help": "留空即可/.test(clientSrc));
	check("说明自动挑选模型时不是自己指定的", clientSrc.includes('tt("model.auto")'));
	check("拼错提示有专门样式", clientSrc.includes(".dshap-warn{"));
	check("模型名芯片可点击", /dshap-chip-btn/.test(clientSrc) && /onClick: \(\) => set\("model",/.test(clientSrc));

	// A hardcoded example vendor ages badly: NVIDIA was suggested once and the
	// user asked for it to go. The placeholder now tracks the selected preset, so
	// the example can never point at a vendor the user did not choose.
	check("地址帮助文案不含具体厂商名", !/"form\.base\.help": "[^"]*(nvidia|openrouter|baseten|cerebras|groq|featherless)/i.test(clientSrc));
	check("地址占位符跟随所选服务商", /placeholder: \(PRESETS\.find\(\(p\) => p\.id === form\.preset\)/.test(clientSrc));
	check("占位符兜底用主流厂商", clientSrc.includes('|| "https://api.deepseek.com/v1"'));

	// Slang in a settings hint reads as jokey to some users and opaque to others.
	// Kept out deliberately; this locks it so it does not creep back in.
	check("界面文案不含「翻墙」这类说法", !clientSrc.includes("翻墙"));
	// Keeps the original intent — the hint must talk about needing a network path,
	// not about anything colloquial — but matches the shortened wording.
	check("代理说明讲的是什么时候才需要填", /"adv\.proxy\.help": "[^"]*代理[^"]*留空[^"]*直连/.test(clientSrc), clientSrc.match(/"adv\.proxy\.help": "([^"]*)"/)?.[1]);

	// Model IDs are neither portable nor stable per vendor: one model is
	// deepseek-ai/deepseek-v4.1-flash on NVIDIA, @cf/deepseek/… on Cloudflare,
	// deepseek-chat on DeepSeek's own API, and a relay may rename it again.
	// So there must be NO static name anywhere — not as placeholder, not as chip.
	check("不再硬编码别家厂商的模型名做示例", !clientSrc.includes('placeholder: "gpt-4o-mini'));
	check("占位符不再跟随服务商（已无任何静态名可用）", !clientSrc.includes("modelPlaceholderFor"));
	check("chips 只来自服务商列表，无预设兜底", /chatModelNames\(modelsEvent\?\.models/.test(clientSrc) && !clientSrc.includes("preset?.hints"));
	// The warn line is rendered behind a truthiness guard, so an empty string in
	// both dictionaries means no <p> reaches the DOM. Assert the guard exists —
	// checking that the el() call is absent would only prove a different code shape.
	check("警示渲染受空值保护", /tt\("form\.model\.warn"\)\s*\n?\s*\?\s*el\(/.test(clientSrc));
	check("警示文案为空", /"form\.model\.warn": "",/.test(clientSrc));
	check("不再出现「常见写法」这类会误导的标题", !clientSrc.includes("常见写法"));
	check("chips 标题标明来自该地址的真实列表", /"form\.model\.chiplabel": "[^"]*该地址实际提供的模型/.test(clientSrc));
}

console.log("\n" + "─".repeat(52));
if (failures.length === 0) {
	console.log(`全部通过：${passed} 项`);
	process.exit(0);
}
console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
for (const f of failures) console.log("  · " + f);
process.exit(1);