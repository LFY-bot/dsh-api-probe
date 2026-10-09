/**
 * Mirrors the host's non-chat filter: suggesting an embedding or rerank model
 * here would hand the user a name that cannot answer a chat request.
 *
 * Declared at module top level, outside the factory, so the contract tests can
 * exercise it directly instead of grepping the source.
 */
const NON_CHAT_MODEL = /embed|rerank|whisper|tts|moderation|clip|dall-?e|bge-|m3e|gte-|audio|vision|speech|transcri/i;

/** Pick the most useful model names to offer as one-click chips. */
function chatModelNames(names, limit) {
	const seen = new Set();
	const chat = [];
	const rest = [];
	for (const raw of Array.isArray(names) ? names : []) {
		const name = typeof raw === "string" ? raw.trim() : "";
		if (name === "" || seen.has(name)) continue;
		seen.add(name);
		(NON_CHAT_MODEL.test(name) ? rest : chat).push(name);
	}
	chat.sort();
	// Only fall back to embedding/rerank names when the provider offers nothing
	// else: an empty chip row would silently hide why no model could be picked.
	return (chat.length > 0 ? chat : rest).slice(0, limit);
}

/**
 * Settings worth remembering between runs.
 *
 * `base`, `model` and `preset` are deliberately excluded. This tool's job is
 * "I just got a NEW address, go check it" — restoring yesterday's address into
 * the box is exactly how you end up testing the wrong API without noticing,
 * because a pre-filled field looks like something the app filled in for you.
 * `preset` goes with them: leaving it restored made every fresh open look like
 * the tool had decided which provider the user belongs to.
 */
const PERSISTED_KEYS = [
	"api", "timeout", "rounds", "concurrency", "prompt", "proxy", "insecure",
];

/**
 * Model IDs are not portable, and not even stable per vendor: the same model
 * is deepseek-ai/deepseek-v4.1-flash on NVIDIA, @cf/deepseek/… on Cloudflare,
 * deepseek-chat on DeepSeek's own API. There is therefore no example we could
 * put in the model box that would not be wrong for someone. The placeholder is
 * plain text pointing at where the real names are.
 */

window.__ModuleLoader__.load({
	id: "dsh-api-probe",
	factory: (require) => {
		/* Everything below runs inside this guard. The browser module loader has
		 * no per-plugin try/catch: an exception escaping this factory takes the
		 * whole Web shell down, and the failure names no plugin. That is exactly
		 * how the first released version broke the app. A degraded no-op module
		 * costs one missing panel; an uncaught throw costs every panel. */
		try {
			const react = require("react");

		/* ------------------------------------------------------------------ *
		 * 手写 createElement：本文件由浏览器直接执行，没有编译步骤，
		 * 所以不能用 JSX 语法。
		 * ------------------------------------------------------------------ */
		const el = (type, props, ...kids) => react.createElement(type, props, ...kids);
		const { useState, useEffect, useRef, useMemo, useCallback } = react;

		const PANEL_ID = "api-probe";
		const PANEL_ORDER = 35;
		const NS = "dsh-api-probe";
		const PREFS_KEY = "dsh-api-probe:prefs:v1";

		/* Route paths are DOCUMENT-RELATIVE on purpose (no leading slash): the
		 * harness serves the GUI with `<base href="./">`, so a root-absolute
		 * `/api/...` escapes that prefix and never reaches the host route. */
		const API = {
			probe: "api/dsh-api-probe/probe",
			health: "api/dsh-api-probe/health",
		};

		// Entries carry an ASCII `sort` key and the list is sorted by it below.
		// Two rules decide that key, and both exist so the dropdown cannot
		// quietly reorder itself between releases:
		//
		//   * ASCII, never a collation call. `localeCompare("zh")` resolves through
		//     the host's ICU build, so the same plugin can order the same list
		//     differently on two machines. An order that depends on the host is
		//     worse than plain A-Z.
		//   * Chinese-named and English-named vendors stay in separate blocks.
		//     Interleaving them by one key buried 百川 between Baseten and Cerebras
		//     and pushed 火山引擎 behind Hyperbolic, which just reads as arbitrary.
		//     Two blocks keep each section internally consistent, so someone
		//     scanning for either group only ever moves in one direction.
		//
		// So `sort` is `cn-<pinyin initial>` or `en-<leading letter>`, and 自定义
		// takes `zzz` to pin itself LAST as the escape hatch — a vendor missing
		// from this list is still reachable that way.
		//
		// Presets carry a BASE URL only — never a model ID, and `hints` is always
		// empty. They used to hold hand-written model names ("gpt-4o-mini",
		// "qwen-plus", "meta/llama-3.3-70b-instruct", …), which was actively
		// misleading: the same model is deepseek-ai/deepseek-v4.1-flash on NVIDIA,
		// @cf/deepseek/… on Cloudflare and deepseek-chat on DeepSeek's own API, and
		// relays rename on top of that. A stale chip looks authoritative and walks
		// the user into a 400. The provider's own /models response is the only
		// source that cannot rot, so chips come from the probe result (see
		// `modelChips`) and a blank `model` is what triggers that lookup.
		//
		// A base URL here is a starting point, not a verified promise: vendors
		// move hosts without announcement. tests/check_providers.mjs re-checks the
		// whole list against the live endpoints when you want to trust it again.
		const PRESETS = [
			// ============ 第一梯队：中文服务商，按拼音首字母 A-Z ============
			// A — a-li-yun
			{ id: "dashscope", label: "阿里云百炼 DashScope（通义千问）", api: "openai", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "", hints: [], sort: "cn-a" },
			// B — bai-chuan
			{ id: "baichuan", label: "百川智能 Baichuan", api: "openai", base: "https://api.baichuan-ai.com/v1", model: "", hints: [], sort: "cn-b" },
			// G — gui-ji-liu-dong
			{ id: "siliconflow", label: "硅基流动 SiliconFlow", api: "openai", base: "https://api.siliconflow.cn/v1", model: "", hints: [], sort: "cn-g" },
			// H — huo-shan
			{ id: "volcengine", label: "火山引擎（豆包）", api: "openai", base: "https://ark.cn-beijing.volces.com/api/v3", model: "", hints: [], sort: "cn-h" },
			// J — jie-tiao-xing-chen
			{ id: "jietiao", label: "阶跃星辰 StepFun", api: "openai", base: "https://api.stepfun.com/v1", model: "", hints: [], sort: "cn-j" },
			// M — mo-zha
			{ id: "modelscope", label: "魔搭 ModelScope", api: "openai", base: "https://api-inference.modelscope.cn/v1", model: "", hints: [], sort: "cn-m1" },
			// M — mi-ni-max
			{ id: "minimax", label: "MiniMax 海螺", api: "openai", base: "https://api.minimax.chat/v1", model: "", hints: [], sort: "cn-m2" },
			// S — shang-tang
			{ id: "sensenova", label: "商汤 SenseNova", api: "openai", base: "https://token.sensenova.cn/v1", model: "", hints: [], sort: "cn-s" },
			// X — xun-fei
			{ id: "xfeng", label: "讯飞星火 Spark", api: "openai", base: "https://spark-api-open.xf-yun.com/v1", model: "", hints: [], sort: "cn-x" },
			// Y — yue-zhi-an-mian
			{ id: "moonshot", label: "月之暗面 Moonshot（Kimi）", api: "openai", base: "https://api.moonshot.cn/v1", model: "", hints: [], sort: "cn-y" },
			// Z — zhi-pu
			{ id: "zhipu", label: "智谱 AI（GLM）", api: "openai", base: "https://open.bigmodel.cn/api/paas/v4", model: "", hints: [], sort: "cn-z" },

			// ============ 第二梯队：英文服务商，按字母 A-Z ============
			{ id: "anthropic", label: "Anthropic 官方", api: "anthropic", base: "https://api.anthropic.com/v1", model: "", hints: [], sort: "en-a" },
			{ id: "baseten", label: "Baseten", api: "openai", base: "https://inference.baseten.ai/v1", model: "", hints: [], sort: "en-b" },
			{ id: "cerebras", label: "Cerebras", api: "openai", base: "https://api.cerebras.ai/v1", model: "", hints: [], sort: "en-c" },
			{ id: "chutes", label: "Chutes AI", api: "openai", base: "https://llm.chutes.ai/v1", model: "", hints: [], sort: "en-ch" },
			// The path segment must be the account id, so this one cannot be a working
			// URL out of the box — it is a labelled starting point.
			{ id: "cloudflare", label: "Cloudflare Workers AI", api: "openai", base: "https://api.cloudflare.com/client/v4/accounts/你的账户ID/ai/v1", model: "", hints: [], sort: "en-cl" },
			{ id: "deepinfra", label: "DeepInfra", api: "openai", base: "https://api.deepinfra.com/v1/openai", model: "", hints: [], sort: "en-d1" },
			{ id: "deepseek", label: "DeepSeek 深度求索", api: "openai", base: "https://api.deepseek.com/v1", model: "", hints: [], sort: "en-d2" },
			{ id: "deepseek-anthropic", label: "DeepSeek（Anthropic 原生接口）", api: "anthropic", base: "https://api.deepseek.com/anthropic", model: "", hints: [], sort: "en-d3" },
			{ id: "featherless", label: "Featherless", api: "openai", base: "https://api.featherless.ai/v1", model: "", hints: [], sort: "en-f1" },
			{ id: "fireworks", label: "Fireworks AI", api: "openai", base: "https://api.fireworks.ai/inference/v1", model: "", hints: [], sort: "en-f2" },
			{ id: "gemini", label: "Google Gemini（原生接口）", api: "gemini", base: "https://generativelanguage.googleapis.com/v1beta", model: "", hints: [], sort: "en-g1" },
			{ id: "groq", label: "Groq", api: "openai", base: "https://api.groq.com/openai/v1", model: "", hints: [], sort: "en-g2" },
			{ id: "hyperbolic", label: "Hyperbolic", api: "openai", base: "https://api.hyperbolic.xyz/v1", model: "", hints: [], sort: "en-h" },
			{ id: "llamacpp", label: "llama.cpp / one-api（本地）", api: "openai", base: "http://localhost:8080/v1", model: "", hints: [], sort: "en-l1" },
			{ id: "lmstudio", label: "LM Studio（本地）", api: "openai", base: "http://localhost:1234/v1", model: "", hints: [], sort: "en-l2" },
			{ id: "mistral", label: "Mistral AI", api: "openai", base: "https://api.mistral.ai/v1", model: "", hints: [], sort: "en-m" },
			{ id: "nebius", label: "Nebius AI Studio", api: "openai", base: "https://api.studio.nebius.ai/v1", model: "", hints: [], sort: "en-n1" },
			{ id: "nvidia", label: "NVIDIA NIM（英伟达）", api: "openai", base: "https://integrate.api.nvidia.com/v1", model: "", hints: [], sort: "en-n2" },
			{ id: "novita", label: "Novita AI", api: "openai", base: "https://api.novita.ai/v3/openai", model: "", hints: [], sort: "en-n3" },
			{ id: "ollama", label: "Ollama（本地）", api: "openai", base: "http://localhost:11434/v1", model: "", hints: [], sort: "en-o1" },
			{ id: "openai", label: "OpenAI", api: "openai", base: "https://api.openai.com/v1", model: "", hints: [], sort: "en-o2" },
			{ id: "openrouter", label: "OpenRouter", api: "openai", base: "https://openrouter.ai/api/v1", model: "", hints: [], sort: "en-o3" },
			{ id: "perplexity", label: "Perplexity", api: "openai", base: "https://api.perplexity.ai", model: "", hints: [], sort: "en-p" },
			{ id: "sambanova", label: "SambaNova", api: "openai", base: "https://api.sambanova.ai/v1", model: "", hints: [], sort: "en-s" },
			{ id: "together", label: "Together AI", api: "openai", base: "https://api.together.xyz/v1", model: "", hints: [], sort: "en-t" },
			{ id: "xai", label: "xAI Grok", api: "openai", base: "https://api.x.ai/v1", model: "", hints: [], sort: "en-x" },

			// ============ 兜底：固定在最后 ============
			{ id: "custom", label: "自定义 / 其他（OpenAI 兼容）", api: "openai", base: "", model: "", hints: [], sort: "zzz" },
		].sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));

		const DEFAULT_PROMPT = "用一句话介绍你自己。";

		/* ============================ 国际化 ============================ */

		const zh = {
			"entry.label": "API 体检",
			"page.title": "API 体检",
			"page.subtitle": "填好地址和 Key，点一下按钮，告诉你这个 API 到底能不能用、快不快。",
			"form.provider": "服务商",
			"form.provider.help": "选错没关系，可自行修改地址和模型。",
			"form.base": "API 地址",
			"form.base.help": "只填域名就行，我自动补成 /v1；已带路径的按原样使用。",
			"form.key": "API Key",
			"form.key.help": "仅用于本次请求，不保存。",
			"form.key.show": "显示",
			"form.key.hide": "隐藏",
			"form.model": "模型名",
			"form.model.help": "留空即可——我会从服务商的模型列表里自动挑一个能对话的。",
			"form.api": "接口协议",
			"form.api.help": "OpenAI 兼容＝绝大多数服务商（DeepSeek、Kimi、智谱…）都用这套格式，选它就行；只有 Anthropic、Gemini 官方接口才选后面两项。",
			"adv.summary": "高级设置（一般不用动）",
			"adv.timeout": "超时（秒）",
			"adv.rounds": "测速次数",
			"adv.rounds.help": "越多越准但越慢；建议 3 次。",
			"adv.concurrency": "并发数",
			"adv.concurrency.help": "并发请求数；默认 1 更真实。",
			"adv.prompt": "测试问题",
			"adv.proxy": "代理地址",
			"adv.proxy.help": "仅在需要代理时填写；留空为直连。",
			"adv.insecure": "跳过证书校验（不建议）",
			"run": "开始检测",
			"running": "正在检测…",
			"cancel": "停止",
			"reset": "清空结果",
			"copy": "复制报告",
			"copied": "已复制",
			"foot.key": "Key 和地址、模型名都不记——每次都是空白的，免得忘了清。",
			"foot.needInput": "先把上面的「API 地址」和「API Key」填上，按钮就能点了。",
			"prog.running": "检测中",
			"prog.done": "检测完成",
			"prog.failed": "检测结束（有失败项）",
			"stage.network": "① 网络通不通",
			"stage.auth": "② Key 和模型对不对",
			"stage.probe": "③ 能不能真的说话",
			"stage.speed": "④ 快不快、稳不稳",
			"model.title": "这次测的是哪个模型",
			"model.yours": "这是你自己填的模型名，测的就是它。",
			"model.auto": "这是替你从服务商列表里挑的一个，不是你指定的。如果这不是你打算用的模型，回到上面「模型名」里改成你要的那个。",
			"form.model.chiplabel": "该地址实际提供的模型（点一下填入）：",
			"form.model.placeholder": "查该服务商的文档，或留空自动挑",
			"form.model.warn": "",
			"form.model.chip.title": "点一下把这个模型名填进上面的输入框",
			"models.more": "点击填入模型名；共 {count} 个，此处显示前 14 个。",
			"metric.ttft": "首字延迟",
			"metric.tps": "输出速度",
			"metric.rate": "成功率",
			"metric.ttft.help": "从回车到首字的等待时间，影响等待感。",
			"metric.tps.help": "模型每秒输出字符数，影响阅读流畅度。",
			"metric.rate.help": "成功率越高越可靠。",
			"sample.title": "模型实际说的话",
			"sample.none": "这次没有拿到正文。",
			"fail.title": "失败记录",
			"fail.none": "全部成功，没有失败。",
			"models.title": "服务商提供的模型",
			"checks.title": "检测过程",
			"idle.title": "还没开始",
			"idle.body": "填完上面的地址和 Key，点「开始检测」。",
			"t.good": "很好",
			"t.fair": "还行",
			"t.slow": "偏慢",
			"t.bad": "很差",
			"t.none": "—",
			"s.fast": "几乎不用等",
			"s.wait": "有一点等待",
			"s.slow": "明显在等回复",
			"s.terrible": "等得太久了",
			"p.read": "读起来像看现成文字",
			"p.ok": "读起来挺顺",
			"p.slow": "有点一个字一个字蹦",
			"p.bad": "慢到影响阅读",
			"r.steady": "非常稳",
			"r.stable": "基本稳",
			"r.flaky": "偶尔会抽风",
			"r.bad": "经常失败",
			"tag.auto": "自动挑的",
			"tag.you": "你填的",
		};

		const en = {
			"entry.label": "API Doctor",
			"page.title": "API Doctor",
			"page.subtitle": "Fill in the endpoint and key, press the button, and find out whether this API works and how fast it is.",
			"form.provider": "Provider",
			"form.provider.help": "Provider choice doesn't matter; you can edit the fields below.",
			"form.base": "API address",
			"form.base.help": "Just the host is enough (/v1 is appended); a full path is used as-is.",
			"form.key": "API key",
			"form.key.help": "Used only for this request; not saved.",
			"form.key.show": "Show",
			"form.key.hide": "Hide",
			"form.model": "Model name",
			"form.model.help": "Leave blank — I'll pick a working chat model from the provider's own list.",
			"form.api": "Protocol",
			"form.api.help": "OpenAI-compatible covers most providers (DeepSeek, Kimi, Zhipu…). Only Anthropic and Gemini official APIs need the other two.",
			"adv.summary": "Advanced (usually not needed)",
			"adv.timeout": "Timeout (seconds)",
			"adv.rounds": "Speed-test rounds",
			"adv.rounds.help": "More rounds = more accurate but slower; 3 rounds sufficient.",
			"adv.concurrency": "Concurrency",
			"adv.concurrency.help": "Concurrent requests; default 1 for real-world.",
			"adv.prompt": "Test prompt",
			"adv.proxy": "Proxy",
			"adv.proxy.help": "Set only if using proxy; blank for direct.",
			"adv.insecure": "Skip certificate validation (not recommended)",
			"run": "Run check",
			"running": "Checking…",
			"cancel": "Stop",
			"reset": "Clear result",
			"copy": "Copy report",
			"copied": "Copied",
			"foot.key": "Your key, address and model name are never stored — every run starts blank so you cannot test a stale one by accident.",
			"foot.needInput": "Fill in the API address and API key above to enable the button.",
			"prog.running": "Checking",
			"prog.done": "Check complete",
			"prog.failed": "Finished with failures",
			"stage.network": "1. Is the network reachable?",
			"stage.auth": "2. Are the key and model right?",
			"stage.probe": "3. Can it actually talk?",
			"stage.speed": "4. How fast and stable?",
			"model.title": "Which model this test used",
			"model.yours": "This is the model name you entered — that is what got tested.",
			"model.auto": "Auto-picked from the provider's list, not chosen by you. If it isn't the model you plan to use, change it in the model field above.",
			"form.model.warn": "",
			"form.model.chiplabel": "Models this address actually offers (click to fill):",
			"form.model.placeholder": "check your provider's docs, or leave blank",
			"form.model.chip.title": "Click to fill this model name into the field above",
			"models.more": "Click to fill model field; {count} total, showing first 14.",
			"metric.ttft": "Time to first token",
			"metric.tps": "Output speed",
			"metric.rate": "Success rate",
			"metric.ttft.help": "Time to first character; affects waiting perception.",
			"metric.tps.help": "Output speed; affects reading smoothness.",
			"metric.rate.help": "Success rate; higher means more reliable.",
			"sample.title": "What the model actually said",
			"sample.none": "No body text came back this time.",
			"fail.title": "Failures",
			"fail.none": "All rounds succeeded.",
			"models.title": "Models offered by the provider",
			"checks.title": "Check trace",
			"idle.title": "Nothing run yet",
			"idle.body": "Fill in the address and key above, then press Run check.",
			"t.good": "Great",
			"t.fair": "OK",
			"t.slow": "Slow",
			"t.bad": "Bad",
			"t.none": "—",
			"s.fast": "Almost no waiting",
			"s.wait": "A little waiting",
			"s.slow": "Noticeably waiting",
			"s.terrible": "Waiting far too long",
			"p.read": "Reads like finished text",
			"p.ok": "Reads smoothly",
			"p.slow": "A bit letter-by-letter",
			"p.bad": "Slow enough to hurt",
			"r.steady": "Rock solid",
			"r.stable": "Mostly solid",
			"r.flaky": "Flaky at times",
			"r.bad": "Fails often",
			"tag.auto": "auto-picked",
			"tag.you": "yours",
		};

		let runtimeT;
		function setRuntimeTranslate(t) {
			runtimeT = t;
		}
		function tt(key, values) {
			if (runtimeT !== void 0) {
				const out = runtimeT(key, values);
				if (typeof out === "string" && out !== key) return out;
			}
			let text = zh[key] ?? key;
			if (values !== void 0) {
				for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
			}
			return text;
		}

		/* ============================== 样式 ============================== */

		const CSS = `
/* The scroll fix needs a BOUNDED height, not just overflow-y:auto. Host mounts
   this panel inside a plain block, so flex:1 1 auto resolves to nothing and the
   root simply grows to fit its content — overflow then never triggers and the
   wheel does nothing. max-height:100vh pins the root to the viewport so it
   becomes the scroll container itself; the report's tail is always reachable. */
.dshap-root{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.6;display:flex;flex-direction:column;gap:16px;min-height:0;max-height:100vh;overflow-y:auto;overflow-x:hidden;padding-right:4px}
.dshap-root *{box-sizing:border-box}
.dshap-head{display:flex;flex-direction:column;gap:4px}
.dshap-title{margin:0;font-size:20px;font-weight:650;letter-spacing:.01em}
.dshap-sub{margin:0;color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:12.5px;max-width:62ch}
.dshap-card{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:14px}
.dshap-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dshap-lab{display:flex;align-items:baseline;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c2c2c2)}
.dshap-help{font-weight:400;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dshap-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.dshap-input,.dshap-select{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none}
.dshap-input:focus,.dshap-select:focus{border-color:var(--dsw-alias-brand-primary,#4f8cff)}
.dshap-select{font-family:inherit}
.dshap-keywrap{display:flex;gap:8px;align-items:center}
.dshap-keywrap .dshap-input{flex:1;min-width:0}
.dshap-mini{flex:none;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-secondary,#c2c2c2);font-size:11.5px;cursor:pointer}
.dshap-mini:hover{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.4))}
.dshap-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
/* Explicit colors, not --brand-primary. That token resolves to near-white in
   some themes, and #fff text on a white fill renders the label invisible —
   which is exactly the blank white button this replaced. */
.dshap-btn{padding:9px 18px;border-radius:9px;border:1px solid transparent;font-size:13px;font-weight:600;cursor:pointer;background:linear-gradient(180deg,#3f8cff,#2f6fe0);color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.dshap-btn:hover:not(:disabled){background:linear-gradient(180deg,#4f97ff,#3a7bec)}
/* A dimmed fill on a dark theme turns the button into a washed-out grey lump
   with unreadable text. An empty outline reads as "not available yet", which is
   what it actually means. */
.dshap-btn:disabled{opacity:1;cursor:default;background:transparent;border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.22));color:var(--dsw-alias-label-tertiary,#8a8a8a);font-weight:500}
.dshap-btn-ghost{background:transparent;border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.3));color:var(--dsw-alias-label-secondary,#c2c2c2)}
.dshap-btn-ghost:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
/* Progress: the track is ALWAYS mounted (no conditional render) so the fill can
   grow continuously instead of popping in at its final width. dshap-prog-fill
   carries its own right-edge glow, so the bar reads as "filling" rather than as
   a white slab that suddenly changes colour.

   It must NOT be a flex sibling of the buttons: on that flex line it claimed a
   share of the free space and inflated into a fat full-width block. */
.dshap-prog{height:3px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));overflow:hidden;width:100%;position:relative}
.dshap-prog-fill{height:100%;border-radius:999px;width:0;background:linear-gradient(90deg,#3f8cff,#5aa9ff);transition:width .55s cubic-bezier(.4,0,.2,1),background .55s ease;position:relative;min-width:4px}
/* A leading highlight implies ongoing motion even while a stage is slow. */
.dshap-prog-fill::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);animation:dshap-sheen 1.6s ease-in-out infinite}
@keyframes dshap-sheen{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.dshap-prog-done .dshap-prog-fill{background:linear-gradient(90deg,#3ecf8e,#2fae75)}
.dshap-prog-done .dshap-prog-fill::after{animation:none;opacity:0}
/* The status word is the readable half of the feedback — a 3px bar alone is
   too thin to notice, and this is the only text that says what is happening.
   Weight and size match the check-row labels; it turns green with the bar. */
.dshap-prog-row{display:flex;align-items:center;gap:10px;margin-top:-4px;opacity:0;transition:opacity .3s ease}
.dshap-prog-row.dshap-prog-show{opacity:1}
.dshap-prog-label{flex:none;font-size:12.5px;font-weight:650;color:var(--dsw-alias-label-secondary,#c2c2c2);font-variant-numeric:tabular-nums;opacity:0;transition:opacity .3s ease,color .45s ease}
.dshap-prog-label-show{opacity:1}
.dshap-prog-done .dshap-prog-label{color:#3ecf8e}
.dshap-foot{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dshap-adv{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:10px;padding:0 14px;background:transparent}
.dshap-adv>summary{cursor:pointer;padding:10px 0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c2c2c2);list-style:none}
.dshap-adv>summary::-webkit-details-marker{display:none}
.dshap-adv>summary::before{content:"▸ ";display:inline-block;transition:transform .15s}
.dshap-adv[open]>summary::before{transform:rotate(90deg)}
.dshap-advbody{display:flex;flex-direction:column;gap:12px;padding:4px 0 14px}
.dshap-checkrow{display:flex;align-items:baseline;gap:9px;padding:3px 0;font-size:12.5px}
.dshap-dot{flex:none;width:8px;height:8px;border-radius:50%;transform:translateY(-1px)}
.dshap-s-ok .dshap-dot{background:#3ecf8e}
.dshap-s-warn .dshap-dot{background:#e5a13a}
.dshap-s-fail .dshap-dot{background:#e5484d}
.dshap-s-skip .dshap-dot{background:#6b7280}
.dshap-s-run .dshap-dot{background:#4f8cff;animation:dshap-pulse 1s ease-in-out infinite}
@keyframes dshap-pulse{0%,100%{opacity:1}50%{opacity:.25}}
.dshap-cl{flex:none;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);min-width:5.5em}
.dshap-skip .dshap-cl{color:var(--dsw-alias-label-tertiary,#9a9a9a);font-weight:500}
.dshap-cd{color:var(--dsw-alias-label-tertiary,#9a9a9a);word-break:break-word}
.dshap-ms{flex:none;margin-left:auto;padding-left:10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9a9a);font-variant-numeric:tabular-nums}
.dshap-stage{margin-top:10px}
.dshap-stage-h{font-size:12px;font-weight:650;color:var(--dsw-alias-label-secondary,#c2c2c2);display:flex;align-items:center;gap:8px}
.dshap-verdict{border-radius:12px;padding:16px 18px;border:1px solid;display:flex;flex-direction:column;gap:8px}
.dshap-v-good{background:rgba(62,207,142,.1);border-color:rgba(62,207,142,.45)}
.dshap-v-ok{background:rgba(79,140,255,.1);border-color:rgba(79,140,255,.4)}
.dshap-v-slow{background:rgba(229,161,58,.1);border-color:rgba(229,161,58,.42)}
.dshap-v-bad{background:rgba(229,72,77,.1);border-color:rgba(229,72,77,.45)}
.dshap-v-idle{background:rgba(127,127,127,.1);border-color:rgba(127,127,127,.22)}
.dshap-v-head{font-size:16px;font-weight:650;display:flex;align-items:center;gap:8px}
.dshap-v-list{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary,#c2c2c2);font-size:12.5px;display:flex;flex-direction:column;gap:3px}
.dshap-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.dshap-metric{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:11px;padding:13px 15px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06))}
.dshap-m-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dshap-m-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c2c2c2)}
.dshap-m-val{font-size:25px;font-weight:680;letter-spacing:-.01em;font-variant-numeric:tabular-nums;line-height:1.15}
.dshap-m-note{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dshap-g-good{color:#3ecf8e}.dshap-g-fair{color:#4f8cff}.dshap-g-slow{color:#e5a13a}.dshap-g-bad{color:#e5484d}.dshap-g-none{color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dshap-tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:600;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dshap-sample{margin:0;padding:11px 13px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));font-size:12.5px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dshap-where{margin:9px 0 0;padding:9px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,rgba(230,230,230,.78))}
.dshap-raw{margin:8px 0 0;padding:9px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;color:var(--dsw-alias-label-tertiary,rgba(230,230,230,.62))}
.dshap-chips{display:flex;flex-wrap:wrap;gap:6px}
.dshap-chip{padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));font-size:11.5px;color:var(--dsw-alias-label-secondary,#c2c2c2)}
.dshap-chip-btn{cursor:pointer;font-family:inherit;line-height:1.5;transition:border-color .12s,color .12s}
.dshap-chip-btn:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.34));color:var(--dsw-alias-label-primary,#e6e6e6)}
.dshap-chip-on{border-color:var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-label-primary,#e6e6e6)}
.dshap-hintrow{margin-top:7px}
.dshap-hintlabel{margin-top:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dshap-modelwarn{margin:6px 0 0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9a9a9a)}
.dshap-warn{margin-top:8px;padding:9px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dshap-empty{color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:12.5px;font-style:italic}
.dshap-idle{display:flex;flex-direction:column;align-items:center;gap:6px;padding:34px 16px;text-align:center}
.dshap-idle-t{font-size:14px;font-weight:600;color:var(--dsw-alias-label-secondary,#c2c2c2)}
.dshap-idle-b{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a);max-width:44ch}
.dshap-toggle{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#c2c2c2);cursor:pointer;user-select:none}
.dshap-hrow{font-size:12px;font-weight:650;margin:2px 0 0;color:var(--dsw-alias-label-secondary,#c2c2c2)}
`;

		let styleInjected = false;
		function ensureStyle() {
			if (styleInjected || typeof document === "undefined") return;
			if (document.getElementById("dshap-style")) {
				styleInjected = true;
				return;
			}
			const node = document.createElement("style");
			node.id = "dshap-style";
			node.textContent = CSS;
			document.head.appendChild(node);
			styleInjected = true;
		}

		/* ============================ 小工具 ============================ */

		function fmtMs(ms) {
			if (ms === null || ms === void 0) return "—";
			if (ms < 1000) return `${Math.round(ms)} ms`;
			return `${(ms / 1000).toFixed(2)} s`;
		}
		function fmtTps(tps) {
			if (tps === null || tps === void 0) return "—";
			return `${tps.toFixed(1)} 字/秒`;
		}
		function fmtPct(rate) {
			if (rate === null || rate === void 0) return "—";
			return `${Math.round(rate * 100)}%`;
		}
		function gradeText(grade) {
			const map = { good: "t.good", fair: "t.fair", slow: "t.slow", bad: "t.bad", none: "t.none" };
			return tt(map[grade] ?? "t.none");
		}
		function ttftNote(ms) {
			if (ms === null || ms === void 0) return "—";
			if (ms < 500) return tt("s.fast");
			if (ms < 1200) return tt("s.wait");
			if (ms < 2500) return tt("s.slow");
			return tt("s.terrible");
		}
		function tpsNote(tps) {
			if (tps === null || tps === void 0) return "—";
			if (tps >= 45) return tt("p.read");
			if (tps >= 20) return tt("p.ok");
			if (tps >= 8) return tt("p.slow");
			return tt("p.bad");
		}
		function rateNote(rate) {
			if (rate === null || rate === void 0) return "—";
			if (rate >= 1) return tt("r.steady");
			if (rate >= 0.95) return tt("r.stable");
			if (rate >= 0.8) return tt("r.flaky");
			return tt("r.bad");
		}

		function loadPrefs() {
			const base = {
				preset: "custom", api: "openai", base: "", model: "",
				timeout: 20, rounds: 3, concurrency: 1, prompt: DEFAULT_PROMPT,
				proxy: "", insecure: false,
			};
			try {
				const raw = localStorage.getItem(PREFS_KEY);
				if (!raw) return base;
				const saved = JSON.parse(raw);
				if (saved && typeof saved === "object") {
					for (const key of PERSISTED_KEYS) {
						if (saved[key] !== void 0 && typeof saved[key] === typeof base[key]) base[key] = saved[key];
					}
				}
			} catch {
				/* storage unavailable — fall back to defaults */
			}
			return base;
		}
		/** Persist only the whitelisted settings. The API key, the API address and
		 *  the model name are deliberately NOT part of what gets written. */
		function savePrefs(form) {
			const kept = {};
			for (const key of PERSISTED_KEYS) kept[key] = form[key];
			try {
				localStorage.setItem(PREFS_KEY, JSON.stringify(kept));
			} catch {
				/* ignore quota / private mode */
			}
		}

		/** Read an NDJSON stream and hand each parsed event to onEvent. */
		async function readNdjson(response, onEvent) {
			if (!response.body) {
				const text = await response.text();
				for (const line of text.split("\n")) {
					if (line.trim()) onEvent(JSON.parse(line));
				}
				return;
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let at;
				while ((at = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, at).trim();
					buffer = buffer.slice(at + 1);
					if (!line) continue;
					try {
						onEvent(JSON.parse(line));
					} catch {
						/* ignore a malformed line rather than killing the run */
					}
				}
			}
		}

		function Icon() {
			return el(
				"svg",
				{ width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				el("path", { key: "a", d: "M3.5 13a8.5 8.5 0 0 1 17 0" }),
				el("path", { key: "b", d: "M12 13l4-3" }),
				el("circle", { key: "c", cx: 12, cy: 13, r: 1.5 }),
				el("path", { key: "d", d: "M3.5 17.5h3M10 17.5h3M16.5 17.5h4" }),
			);
		}

		/* ============================ 各组件 ============================ */

		function Field(props) {
			return el(
				"label",
				{ className: "dshap-field" },
				el("span", { className: "dshap-lab" }, props.label, props.help ? el("span", { className: "dshap-help" }, props.help) : null),
				props.children,
			);
		}

		function CheckRow(props) {
			const c = props.check;
			// The resolved IP addresses are only useful when someone needs to
			// verify the network path — beginners read "success" and move on.
			// Keep the IP out of the main line and tuck it into a collapsed
			// "technical details" row instead.
			return el(
				"div",
				{ className: `dshap-checkrow dshap-s-${c.status}` },
				el("span", { className: "dshap-dot" }),
				el("span", { className: "dshap-cl" }, c.label),
				el("span", { className: "dshap-cd" }, c.detail),
				c.techDetail ? el(
					"details",
					{ className: "dshap-tech" },
					el("summary", null, "技术详情"),
					el("span", { className: "dshap-cd" }, c.techDetail),
				) : null,
				c.ms !== null && c.ms !== void 0 ? el("span", { className: "dshap-ms" }, fmtMs(c.ms)) : null,
			);
		}

		function Metric(props) {
			return el(
				"div",
				{ className: "dshap-metric" },
				el("div", { className: "dshap-m-top" }, el("span", { className: "dshap-m-name" }, props.name), el("span", { className: "dshap-tag" }, gradeText(props.grade))),
				el("div", { className: `dshap-m-val dshap-g-${props.grade ?? "none"}` }, props.value),
				el("div", { className: "dshap-m-note" }, props.note),
			);
		}

		function VerdictBanner(props) {
			const v = props.verdict;
			const level = v && v.level ? v.level : "bad";
			return el(
				"div",
				{ className: `dshap-verdict dshap-v-${level}` },
				el("div", { className: "dshap-v-head" }, props.error ? tt("idle.title") : v.headline),
				props.error
					? el("p", { className: "dshap-m-note", style: { margin: 0 } }, props.error)
					: el(
							"ul",
							{ className: "dshap-v-list" },
							...(v.reasons ?? []).map((reason, index) => el("li", { key: index }, reason)),
						),
			);
		}

		function Panel() {
			const [form, setForm] = useState(loadPrefs);
			const [key, setKey] = useState("");
			const [showKey, setShowKey] = useState(false);
			const [events, setEvents] = useState([]);
			const [result, setResult] = useState(null);
			const [running, setRunning] = useState(false);
			const [fatal, setFatal] = useState(null);
			const [copied, setCopied] = useState(false);
			const abortRef = useRef(null);

			useEffect(() => {
				ensureStyle();
			}, []);

			const set = useCallback((field, value) => {
				setForm((prev) => {
					const next = { ...prev, [field]: value };
					if (field !== "preset") next.preset = matchPreset(next);
					savePrefs(next);
					return next;
				});
			}, []);

			function matchPreset(f) {
				const hit = PRESETS.find((p) => p.base === f.base && p.api === f.api && p.model === f.model);
				return hit ? hit.id : "custom";
			}

			function onPreset(id) {
				const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0];
				const next = { ...form, preset: id, api: preset.api, base: preset.base, model: preset.model };
				savePrefs(next);
				setForm(next);
			}

			const onRun = useCallback(async () => {
				if (running) return;
				setRunning(true);
				setFatal(null);
				setResult(null);
				setCopied(false);
				setEvents([]);
				const controller = new AbortController();
				abortRef.current = controller;
				try {
					const response = await fetch(API.probe, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							base: form.base.trim(),
							key: key.trim(),
							model: form.model.trim(),
							api: form.api,
							timeout: Number(form.timeout) || 20,
							rounds: Number(form.rounds) || 3,
							concurrency: Number(form.concurrency) || 1,
							prompt: form.prompt || DEFAULT_PROMPT,
							proxy: form.proxy.trim(),
							insecure: form.insecure === true,
						}),
						signal: controller.signal,
					});
					if (!response.ok) {
						// The host answers with { error } for 403/405/400. Swallowing it
						// would hide "loopback-only" behind a bare status code.
						let detail = "";
						try {
							const body = await response.json();
							if (body && typeof body.error === "string") detail = `（${body.error}）`;
						} catch {
							/* keep the bare status */
						}
						setFatal(`请求失败（HTTP ${response.status}）${detail}。宿主插件可能没装好，刷新页面再试。`);
						return;
					}
					await readNdjson(response, (event) => {
						if (event.type === "result") setResult(event.result);
						else setEvents((prev) => prev.concat(event));
					});
				} catch (error) {
					if (error && error.name === "AbortError") setFatal(tt("running") + " — " + tt("cancel"));
					else setFatal(`连不上体检服务：${error && error.message ? error.message : String(error)}`);
				} finally {
					abortRef.current = null;
					setRunning(false);
				}
			}, [running, form, key]);

			function onCancel() {
				if (abortRef.current) abortRef.current.abort();
			}

			const groups = useMemo(() => {
				const out = [];
				let current = null;
				for (const event of events) {
					if (event.type === "stage") {
						current = { stage: event.stage, title: event.title, checks: [] };
						out.push(current);
					} else if (event.type === "check" && current) {
						current.checks.push(event);
					} else if (event.type === "metrics") {
						out.push({ stage: "metrics", title: event, checks: [] });
					} else if (event.type === "sample") {
						out.push({ stage: "sample", title: event, checks: [] });
					} else if (event.type === "models") {
						out.push({ stage: "models", title: event, checks: [] });
					} else if (event.type === "model") {
						out.push({ stage: "model", title: event, checks: [] });
					}
				}
				return out;
			}, [events]);

			const liveMetrics = useMemo(() => {
				for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === "metrics") return events[i];
				return null;
			}, [events]);
			const sampleEvent = useMemo(() => {
				for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === "sample") return events[i];
				return null;
			}, [events]);
			const modelsEvent = useMemo(() => {
				for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === "models") return events[i];
				return null;
			}, [events]);
			const modelEvent = useMemo(() => {
				for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === "model") return events[i];
				return null;
			}, [events]);

			// Chips come ONLY from the provider's own /models response. There is no
			// static fallback: the same model carries a different ID at every vendor
			// (deepseek-ai/deepseek-v4.1-flash on NVIDIA, @cf/deepseek/… on
			// Cloudflare, deepseek-chat on DeepSeek's own API), and a relay may be
			// hosting upstream names, its own aliases, or both. Guessing one is
			// guessing something only the user knows, and a wrong guess 404s.
			const modelChips = useMemo(() => chatModelNames(modelsEvent?.models, 10), [modelsEvent]);

			/* No static example: any name we could print would be wrong for some
			 * provider. The placeholder points at where the real names live. */
			const modelPlaceholder = tt("form.model.placeholder");

			const metrics = result ? result.metrics : liveMetrics;
			const speed = result ? result.stages?.speed : null;

			// Four pipeline stages; the bar advances one notch per stage that has
			// reported anything, and jumps to 100 once a result exists. Deriving it
			// from emitted events (not a timer) keeps it honest when a stage fails
			// fast or the speed test takes ten times as long as the rest.
			//
			// Stages contribute a geometric share of the bar rather than a flat 25%
			// each, so the fill keeps creeping forward during a slow stage instead of
			// parking on a hard 24% / 48% step that looks like a frozen bar.
			const progress = useMemo(() => {
				if (result) return 100;
				if (events.length === 0) return 2;
				const stages = new Set();
				let latest = 0;
				for (const event of events) {
					if (event.type === "stage") stages.add(event.stage);
					// The last check's timing is the freshest progress signal we have.
					if (typeof event.ms === "number" && event.ms > latest) latest = event.ms;
				}
				// 6 / 15 / 30 / 52 % — each stage unlocks a bigger slice of the bar.
				const stops = [6, 15, 30, 52];
				const done = Math.min(stages.size, 4);
				const base = stops[done - 1] ?? 2;
				// Creep toward the next stop using the slowest observed check, so a
				// request that is still open shows movement. Capped so the bar can
				// never reach the next stop (and never imply false completion).
				const creep = Math.min(10, latest / 180);
				return Math.min(96, base + creep);
			}, [events, result]);

			const onCopy = useCallback(async () => {
				if (!result) return;
				const v = result.verdict;
				const sampleStage = result.stages?.sample ?? null;
				const authStage = result.stages?.auth ?? null;
				const lines = [
					`# ${tt("page.title")} — ${result.config?.base ?? ""}`,
					``,
					`**${v?.headline ?? ""}**`,
					...(v?.reasons ?? []).map((r) => `- ${r}`),
					``,
					// The exact observation matters when the verdict is disputed — the
					// phase says whether bytes ever left this machine.
					`卡在哪一步: ${sampleStage?.phase ?? "未进入对话测试"}`,
					`测试用的模型: ${result.stages?.model ?? "（未确定）"}${result.stages?.modelAuto ? "（自动挑选，非你指定）" : ""}`,
					result.stages?.modelNotice ? `模型名提示: ${result.stages.modelNotice}` : ``,
					`请求阶段诊断: ${authStage?.diagnosis?.title ?? sampleStage?.diagnosis?.title ?? "无"}`,
					sampleStage?.diagnosis?.detail ? `细节: ${sampleStage.diagnosis.detail}` : ``,
					sampleStage?.error ? `服务商原文: ${String(sampleStage.error).slice(0, 500)}` : ``,
					``,
					`| ${tt("metric.ttft")} | ${fmtMs(metrics?.ttftMedian)} |`,
					`| ${tt("metric.tps")} | ${fmtTps(metrics?.tpsMedian)} |`,
					`| ${tt("metric.rate")} | ${fmtPct(metrics?.successRate)} (${metrics?.successes ?? 0}/${metrics?.attempts ?? 0}) |`,
					``,
					`Key: \`${result.config?.keyMasked ?? ""}\``,
				];
				try {
					await navigator.clipboard.writeText(lines.join("\n"));
					setCopied(true);
					setTimeout(() => setCopied(false), 1800);
				} catch {
					setCopied(false);
				}
			}, [result, metrics]);

			return el(
				"div",
				{ className: "dshap-root" },
				/* ---- 标题 ---- */
				el(
					"div",
					{ className: "dshap-head" },
					el("h2", { className: "dshap-title" }, tt("page.title")),
					el("p", { className: "dshap-sub" }, tt("page.subtitle")),
				),

				/* ---- 表单 ---- */
				el(
					"div",
					{ className: "dshap-card" },
					el(
						"div",
						{ className: "dshap-grid2" },
						el(Field, { label: tt("form.provider"), help: tt("form.provider.help") }, el(
							"select",
							{ className: "dshap-select", value: form.preset, onChange: (e) => onPreset(e.target.value) },
							...PRESETS.map((p) => el("option", { key: p.id, value: p.id }, p.label)),
						)),
						el(Field, { label: tt("form.base"), help: tt("form.base.help") }, el("input", {
							className: "dshap-input", value: form.base, spellCheck: false, autoComplete: "off",
							// Follows the selected provider so the example is the one the
							// user just chose, rather than a hardcoded vendor that may be
							// rare where they are. Falls back to a mainstream default.
							placeholder: (PRESETS.find((p) => p.id === form.preset)?.base) || "https://api.deepseek.com/v1",
							onChange: (e) => set("base", e.target.value),
						})),
					),
					el(
						"div",
						{ className: "dshap-grid2" },
						el(Field, { label: tt("form.key"), help: tt("form.key.help") }, el(
							"div",
							{ className: "dshap-keywrap" },
							el("input", {
								className: "dshap-input", type: showKey ? "text" : "password", value: key,
								spellCheck: false, autoComplete: "off", placeholder: "sk-…",
								onChange: (e) => setKey(e.target.value),
							}),
							el("button", { className: "dshap-mini", type: "button", onClick: () => setShowKey((v) => !v) }, showKey ? tt("form.key.hide") : tt("form.key.show")),
						)),
						el(
						"div",
						null,
						el(Field, { label: tt("form.model"), help: tt("form.model.help") }, el("input", {
							className: "dshap-input", value: form.model, spellCheck: false, autoComplete: "off",
							placeholder: modelPlaceholder,
							onChange: (e) => set("model", e.target.value),
						})),
						// Model IDs are provider-specific and the examples beside this box
						// are easy to copy by reflex, so say so before they cause a 400.
						// Nothing is printed under the model box on purpose. An explanatory note here
					// reads as a warning about the field the user is looking at, and the
					// honest advice ("look up your provider's ID") is not actionable
					// without knowing the provider anyway. Real guidance appears where
					// it applies: the provider list after a run, and the 404 hint.
					tt("form.model.warn")
						? el("p", { className: "dshap-modelwarn" }, tt("form.model.warn"))
						: null,
						// Typing a model name from memory is where beginners go wrong, so
						// offer the names we know for this provider as one-click chips.
						modelChips.length > 0
							? el(
									"div",
									{ className: "dshap-hintrow" },
									el("span", { className: "dshap-hintlabel" }, tt("form.model.chiplabel")),
									el(
										"div",
										{ className: "dshap-chips" },
										...modelChips.map((name) =>
											el("button", {
												className: `dshap-chip dshap-chip-btn${form.model === name ? " dshap-chip-on" : ""}`,
												type: "button", key: name, title: tt("form.model.chip.title"),
												onClick: () => set("model", name),
											}, name),
										),
									),
								)
							: null,
					),
					),
					el(
						"details",
						{ className: "dshap-adv" },
						el("summary", null, tt("adv.summary")),
						el(
							"div",
							{ className: "dshap-advbody" },
							el(
								"div",
								{ className: "dshap-grid2" },
								el(Field, { label: tt("adv.timeout") }, el("input", {
									className: "dshap-input", type: "number", min: 3, max: 120, value: form.timeout,
									onChange: (e) => set("timeout", e.target.value),
								})),
								el(Field, { label: tt("adv.rounds"), help: tt("adv.rounds.help") }, el("input", {
									className: "dshap-input", type: "number", min: 1, max: 10, value: form.rounds,
									onChange: (e) => set("rounds", e.target.value),
								})),
							),
							el(
								"div",
								{ className: "dshap-grid2" },
								el(Field, { label: tt("adv.concurrency"), help: tt("adv.concurrency.help") }, el("input", {
									className: "dshap-input", type: "number", min: 1, max: 5, value: form.concurrency,
									onChange: (e) => set("concurrency", e.target.value),
								})),
								el(Field, { label: tt("form.api"), help: tt("form.api.help") }, el(
									"select",
									{ className: "dshap-select", value: form.api, onChange: (e) => set("api", e.target.value) },
									el("option", { value: "openai" }, "OpenAI 兼容（绝大多数服务商）"),
									el("option", { value: "anthropic" }, "Anthropic 原生"),
									el("option", { value: "gemini" }, "Google Gemini 原生"),
								)),
							),
							el(Field, { label: tt("adv.prompt") }, el("input", {
								className: "dshap-input", value: form.prompt,
								onChange: (e) => set("prompt", e.target.value),
							})),
							el(Field, { label: tt("adv.proxy"), help: tt("adv.proxy.help") }, el("input", {
								className: "dshap-input", value: form.proxy, spellCheck: false, autoComplete: "off",
								placeholder: "http://127.0.0.1:7890",
								onChange: (e) => set("proxy", e.target.value),
							})),
							el("label", { className: "dshap-toggle" }, el("input", {
								type: "checkbox", checked: form.insecure,
								onChange: (e) => set("insecure", e.target.checked),
							}), el("span", null, tt("adv.insecure"))),
						),
					),
					el(
						"div",
						{ className: "dshap-actions" },
						running
							? el("button", { className: "dshap-btn", type: "button", onClick: onCancel }, tt("cancel"))
							: el(
										"button",
										{
											className: "dshap-btn",
											type: "button",
											disabled: form.base.trim() === "" || key.trim() === "",
											// A dead button with no explanation reads as broken; name the
											// missing field in the tooltip instead.
											title: form.base.trim() === "" || key.trim() === "" ? tt("foot.needInput") : "",
											onClick: onRun,
										},
										tt("run"),
									),
						result
							? el("button", { className: "dshap-btn dshap-btn-ghost", type: "button", onClick: onCopy }, copied ? tt("copied") : tt("copy"))
							: null,
						result || events.length
							? el("button", {
									className: "dshap-btn dshap-btn-ghost", type: "button",
									onClick: () => { setResult(null); setEvents([]); setFatal(null); },
								}, tt("reset"))
							: null,
						el("span", { className: "dshap-foot" }, form.base.trim() === "" || key.trim() === "" ? tt("foot.needInput") : tt("foot.key")),
					),
					/* Track and label stay mounted; only their opacity toggles.
					   Conditional rendering would remount the fill at its final
					   width, which is what produced the "sudden white bar" jump.
					   They live in their own row so the bar cannot stretch
					   against the buttons. */
					el(
						"div",
						{ className: `dshap-prog-row${running || result ? " dshap-prog-show" : ""}${running ? "" : " dshap-prog-done"}` },
						el(
							"div",
							{ className: "dshap-prog" },
							el("div", { className: "dshap-prog-fill", style: { width: `${progress}%` } }),
						),
						el(
							"span",
							{ className: `dshap-prog-label${running || result ? " dshap-prog-label-show" : ""}` },
							running ? tt("prog.running") : result ? tt("prog.done") : "",
						),
					),
				),

				/* ---- 进行中 / 结果 ---- */
				fatal ? el(VerdictBanner, { error: fatal }) : result ? el(VerdictBanner, { verdict: result.verdict, error: result.error }) : el(VerdictBanner, { verdict: { level: "idle", headline: tt("idle.title") } }),

				metrics
					? el(
							"div",
							{ className: "dshap-metrics" },
							el(Metric, {
								name: tt("metric.ttft"), grade: metrics.ttftGrade,
								value: fmtMs(metrics.ttftMedian), note: ttftNote(metrics.ttftMedian),
							}),
							el(Metric, {
								name: tt("metric.tps"), grade: metrics.tpsGrade,
								value: fmtTps(metrics.tpsMedian), note: tpsNote(metrics.tpsMedian),
							}),
							el(Metric, {
								name: tt("metric.rate"), grade: metrics.rateGrade,
								value: fmtPct(metrics.successRate),
								note: `${rateNote(metrics.successRate)} · ${metrics.successes ?? 0}/${metrics.attempts ?? 0}`,
							}),
						)
					: null,

				sampleEvent
					? el(
							"div",
							{ className: "dshap-card" },
							el("div", { className: "dshap-hrow" }, tt("sample.title")),
							sampleEvent.text
								? el("pre", { className: "dshap-sample" }, sampleEvent.text)
								: el("p", { className: "dshap-empty" }, tt("sample.none")),
							// "no text came back" is ambiguous on its own: the request may
							// never have left the machine. Always say where it stopped.
							sampleEvent.where && !sampleEvent.ok
								? el("div", { className: "dshap-where" }, sampleEvent.where)
								: null,
							sampleEvent.error && !sampleEvent.ok
								? el("pre", { className: "dshap-raw" }, String(sampleEvent.error).slice(0, 600))
								: null,
						)
					: null,

				speed && speed.failures && speed.failures.length
					? el(
							"div",
							{ className: "dshap-card" },
							el("div", { className: "dshap-hrow" }, `${tt("fail.title")} (${speed.failures.length})`),
							el("pre", { className: "dshap-sample" }, speed.failures.map((f, index) => `#${index + 1} ${f.where ? f.where + "\n" : ""}${f.error ?? ""}`).join("\n\n")),
						)
					: null,

				modelEvent
					? el(
							"div",
							{ className: "dshap-card" },
							el("div", { className: "dshap-hrow" }, tt("model.title")),
							el("div", { className: "dshap-where" }, modelEvent.auto ? tt("model.auto") : tt("model.yours")),
							modelEvent.notice ? el("div", { className: "dshap-warn" }, modelEvent.notice) : null,
						)
					: null,

				modelsEvent && modelsEvent.models && modelsEvent.models.length
					? el(
							"div",
							{ className: "dshap-card" },
							el("div", { className: "dshap-hrow" }, tt("models.title")),
							el(
								"div",
								{ className: "dshap-chips" },
								...chatModelNames(modelsEvent.models, 14).map((n) =>
									el("button", {
										className: `dshap-chip dshap-chip-btn${form.model === n ? " dshap-chip-on" : ""}`,
										type: "button", key: n, onClick: () => set("model", n),
									}, n),
								),
							),
							el("div", { className: "dshap-hintlabel" }, tt("models.more", { count: modelsEvent.models.length })),
						)
					: null,

				groups.some((g) => g.stage !== "metrics" && g.stage !== "sample" && g.stage !== "models" && g.stage !== "model")
					? el(
							"div",
							{ className: "dshap-card" },
							el("div", { className: "dshap-hrow" }, tt("checks.title")),
							...groups
								.filter((g) => ["network", "auth", "probe", "speed"].includes(g.stage))
								.map((g) =>
									el(
										"div",
										{ className: "dshap-stage", key: g.stage },
										el("div", { className: "dshap-stage-h" }, tt(`stage.${g.stage}`)),
										...g.checks.map((c, index) => el(CheckRow, { key: `${g.stage}-${index}`, check: c })),
									),
								),
						)
					: null,

				!result && !fatal && events.length === 0 && !running
					? el(
							"div",
							{ className: "dshap-card" },
							el(
								"div",
								{ className: "dshap-idle" },
								el(Icon, null),
								el("div", { className: "dshap-idle-t" }, tt("idle.title")),
								el("div", { className: "dshap-idle-b" }, tt("idle.body")),
							),
						)
					: null,
			);
		}

		/* ============================ 注册 ============================ */

		function registerPanel(ctx) {
			const slots = ctx.slots;
			const disposers = [];
			// Both seats are declared by shell plugins this package does not depend on,
			// so each registration is wrapped in slots.inject: a shell that never declares
			// the seat leaves the panel absent instead of failing boot.
			disposers.push(slots.inject("sidebar.panellist", () => slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: PANEL_ORDER,
				label: () => tt("entry.label"),
			}, Icon)));
			disposers.push(slots.inject("main", () => slots.register({
				name: "main",
				key: PANEL_ID,
				inject: () => ({}),
			}, Panel)));
			return () => {
				for (const dispose of disposers.splice(0)) dispose();
			};
		}

		const inject = ["slots", "locale", "layout"];

		function apply(ctx) {
			ctx.effect(() => {
				try {
					return ctx.locale.register(NS, { zh, en });
				} catch {
					return () => {};
				}
			}, "api-probe: dictionaries");
			try {
				setRuntimeTranslate(ctx.locale.bind(NS));
			} catch {
				/* keep the built-in zh dictionary */
			}
			const disposers = [];
			try {
				disposers.push(registerPanel(ctx));
			} catch (error) {
				console.warn("[api-probe] panel registration failed:", error);
			}
			ctx.effect(() => () => {
				for (const dispose of disposers.splice(0)) dispose();
			}, "api-probe: panel");
		}

		/* The module loader calls this factory and uses its RETURN VALUE as the
		 * plugin module. Omitting the return hands it `undefined`, and the web
		 * shell fails to boot with no plugin-specific hint — that is exactly
		 * what the first shipped version did. */
			return { inject, apply };
		} catch (error) {
			console.error("[api-probe] client factory failed; panel disabled:", error);
			return { inject: [], apply() {} };
		}
	},
});