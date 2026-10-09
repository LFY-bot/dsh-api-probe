/**
 * dsh-api-probe — host half.
 *
 * Serves the API health-check as a small NDJSON stream over one POST route:
 * the browser posts a target (base url / key / model), the host runs the four
 * probe stages and emits one event per check as it happens, so the panel can
 * show live progress instead of a spinner for the whole run.
 *
 * Why raw sockets instead of `fetch`: the headline number this tool exists to
 * produce is time-to-first-token, and `fetch` gives no guarantee about when a
 * chunk actually lands (its reader surfaces whatever the decompressor has
 * flushed). Driving `node:http`/`node:tls` directly means every SSE chunk is
 * timestamped on arrival, and it makes HTTP proxy support a two-line add: open
 * a CONNECT tunnel, then speak plain HTTP over the raw socket.
 *
 * The key is read from the request body, lives only in this function's stack,
 * and is never written to a log line or a response body.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";

/** Route family. The client bundle mirrors these literals. */
export const ROUTES = {
	probe: "/api/dsh-api-probe/probe",
	health: "/api/dsh-api-probe/health",
};

/** Stable cordis plugin name. */
export const name = "api-probe";

/** Services required before the probe routes can mount. */
export const inject = ["webServer"];

// ---------------------------------------------------------------------------
// presets
//
// The provider list lives in lib/client.js and ONLY there — it drives the
// dropdown, so a second copy on the host side could never stay in sync with it.
//
// There used to be one here: 10 entries with hand-written model IDs
// (`claude-sonnet-4-20250514`, `gemini-2.5-flash`, `qwen-plus`, …). Nothing read
// it except a `presets: 10` count on the health route, which contradicted the
// 38 the panel actually shows, and it carried exactly the failure mode the
// client list was rebuilt to avoid: a dated model snapshot that silently rots
// and then sends the user into a 400. Model IDs are the vendor's to change, so
// the only trustworthy source is that endpoint's own /models response.
//
// If you need the list on the host, read it from the client module rather than
// copying it here.
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT = "用一句话介绍你自己。";

// ---------------------------------------------------------------------------
// trust fence
// ---------------------------------------------------------------------------

function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const v = address.toLowerCase();
	if (v === "::1") return true;
	if (v.startsWith("::ffff:")) return isIPv4Loopback(v.slice(7));
	return isIPv4Loopback(v);
}

function isLoopbackHostname(hostname) {
	return hostname === "localhost" || hostname === "[::1]" || isIPv4Loopback(hostname);
}

/**
 * Request-level trust fence.
 *
 * The probe route takes an API key and dials an arbitrary outbound URL, so it
 * is loopback-only unless remoteWebUiPairing is loaded and the request carries
 * a live paired-device cookie. The socket address is authoritative;
 * X-Forwarded-For is never trusted.
 * @param request - the incoming request.
 * @returns whether the socket address, Host header and browser same-origin
 * markers all agree this came from this machine's own GUI.
 */
function isLoopbackRequest(request) {
	if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

function isPairingAccess(value) {
	return value !== undefined && value !== null && typeof value.isPairedDevice === "function";
}

/**
 * Loopback, or a live paired-device cookie when remote-web-ui is loaded.
 *
 * This is the single trust-fence gate for both routes — deliberately one
 * function, not two near-identical copies that can drift apart.
 * @param ctx - host plugin context, used to look up remoteWebUiPairing.
 * @param request - the incoming request.
 */
function isPairedOrLoopbackAllowed(ctx, request) {
	if (isLoopbackRequest(request)) return true;
	let fromGet;
	try {
		fromGet = typeof ctx.get === "function" ? ctx.get("remoteWebUiPairing", false) : undefined;
	} catch {
		fromGet = undefined;
	}
	const pairing = isPairingAccess(fromGet) ? fromGet : ctx.remoteWebUiPairing;
	return pairing?.isPairedDevice(request) === true;
}

// ---------------------------------------------------------------------------
// http plumbing
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, message, onTimeout) {
	let timer;
	const guard = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			if (onTimeout) onTimeout();
			reject(new Error(message));
		}, ms);
	});
	return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function tcpConnect({ host, port, timeoutMs }) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host, port });
		const fail = (error) => {
			socket.destroy();
			reject(error);
		};
		socket.setTimeout(timeoutMs, () => fail(new Error(`连接 ${host}:${port} 超时（${timeoutMs}ms 内无响应）`)));
		socket.once("error", fail);
		socket.once("connect", () => {
			socket.setTimeout(0);
			socket.off("error", fail);
			resolve(socket);
		});
	});
}

/** Open a CONNECT tunnel through an HTTP proxy and hand back the raw socket. */
function connectTunnel({ proxyUrl, host, port, timeoutMs }) {
	const target = `${host}:${port}`;
	return new Promise((resolve, reject) => {
		const proxy = new URL(proxyUrl);
		const request = http.request({
			host: proxy.hostname,
			port: Number(proxy.port) || 80,
			method: "CONNECT",
			path: target,
			headers: { Host: target },
			agent: false,
		});
		request.setTimeout(timeoutMs, () => {
			request.destroy(new Error(`代理 ${proxy.host} 连接超时`));
		});
		request.once("error", (error) => {
			reject(new Error(`代理连接失败：${error.message}`));
		});
		request.once("connect", (response, socket) => {
			if (response.statusCode !== 200) {
				socket.destroy();
				reject(new Error(`代理返回 ${response.statusCode}，拒绝 CONNECT ${target}`));
				return;
			}
			socket.setTimeout(0);
			resolve(socket);
		});
		request.end();
	});
}

function tlsUpgrade(socket, servername, insecure, timeoutMs) {
	return new Promise((resolve, reject) => {
		const secure = tls.connect({
			socket,
			servername,
			rejectUnauthorized: insecure !== true,
		});
		secure.setTimeout(timeoutMs, () => {
			secure.destroy(new Error(`TLS 握手超时（${timeoutMs}ms）`));
		});
		secure.once("error", (error) => reject(error));
		secure.once("secureConnect", () => {
			secure.setTimeout(0);
			resolve(secure);
		});
	});
}

/**
 * Establish the byte pipe for one request: direct TCP (+TLS), or a CONNECT
 * tunnel followed by TLS when a proxy is configured.
 */
async function establish(url, cfg, timeoutMs) {
	const secure = url.protocol === "https:";
	const port = url.port ? Number(url.port) : secure ? 443 : 80;
	const host = url.hostname;
	let socket;
	try {
		if (cfg.proxy) {
			socket = await connectTunnel({ proxyUrl: cfg.proxy, host, port, timeoutMs });
		} else {
			socket = await tcpConnect({ host, port, timeoutMs });
		}
	} catch (error) {
		error.probePhase = cfg.proxy ? "proxy" : "connect";
		throw error;
	}
	if (!secure) return socket;
	try {
		return await tlsUpgrade(socket, host, cfg.insecure === true, timeoutMs);
	} catch (error) {
		socket.destroy();
		error.probePhase = "tls";
		throw error;
	}
}

/**
 * Send one request over an established socket and resolve on response headers.
 *
 * Everything that can go wrong here collapses into one identical message if you
 * only look at "no response arrived" — which is exactly how a tool ends up
 * claiming an API is dead when all it knows is that its own request stalled.
 * So every failure carries a `probePhase` saying where it died, and the trace
 * records whether the request bytes were actually handed to the socket and
 * whether the peer closed before saying anything.
 */
function sendRequest({ url, socket, cfg, method, headers, body, timeoutMs }) {
	return new Promise((resolve, reject) => {
		const secure = url.protocol === "https:";
		const mod = secure ? https : http;
		const trace = { phase: "connect", sentBytes: 0, closedBeforeStatus: false, status: null };
		let sawResponse = false;
		const request = mod.request({
			host: url.hostname,
			port: url.port ? Number(url.port) : secure ? 443 : 80,
			path: (url.pathname || "/") + (url.search || ""),
			method,
			headers,
			createConnection: () => socket,
			agent: false,
		});
		const kill = (message, phase) => {
			const error = new Error(message);
			error.probePhase = phase ?? trace.phase;
			error.probeTrace = { ...trace, phase: error.probePhase };
			try {
				request.destroy();
			} catch {
				/* already gone */
			}
			try {
				socket.destroy();
			} catch {
				/* already gone */
			}
			reject(error);
		};
		// The peer hanging up before it says anything is a different failure from
		// "no reply yet" — only this listener can tell the two apart.
		socket.once("close", () => {
			trace.closedBeforeStatus = !sawResponse;
			if (!sawResponse) kill("对端在给出任何回应之前就把连接关断了", "closed");
		});
		trace.phase = "write";
		trace.sentBytes = body === undefined ? 0 : Buffer.byteLength(String(body));
		request.setTimeout(timeoutMs, () => kill(`请求超时（${timeoutMs}ms 内服务端没有完整响应）`, "wait-status"));
		request.once("error", (error) => kill(error.message, "write"));
		request.once("response", (response) => {
			sawResponse = true;
			trace.phase = "status";
			trace.status = response.statusCode ?? null;
			resolve({ request, response, trace });
		});
		if (body === undefined) request.end();
		else request.end(body);
		void cfg;
	});
}

/** Read an entire response body as text (non-streaming endpoints). */
async function readAll(response, limitBytes = 4 * 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of response) {
		size += chunk.length;
		if (size > limitBytes) break;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Yield SSE `data:` payloads as they arrive, one per line.
 * `[DONE]` is yielded like any other payload so the caller decides what ends
 * the stream (Gemini never sends it).
 */
async function* ssePayloads(response) {
	let buffer = "";
	for await (const chunk of response) {
		buffer += chunk.toString("utf8");
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (line === "" || !line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (payload !== "") yield payload;
		}
	}
	const tail = buffer.trim();
	if (tail.startsWith("data:")) {
		const payload = tail.slice(5).trim();
		if (payload !== "") yield payload;
	}
}

// ---------------------------------------------------------------------------
// url + auth helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a user-typed base url: drop trailing slashes, and supply the
 * `/v1` that OpenAI-compatible providers expect when the user pasted only a
 * host. Anything with an explicit path is left untouched so a relay station's
 * custom prefix survives.
 */
export function normBase(raw) {
	let text = String(raw ?? "").trim();
	if (text === "") return "";
	if (!/^https?:\/\//i.test(text)) text = "https://" + text;
	text = text.replace(/\/+$/, "");
	let parsed;
	try {
		parsed = new URL(text);
	} catch {
		return text;
	}
	// Always clear search and hash - they're not part of the base URL for our purposes
	parsed.search = "";
	parsed.hash = "";
	
	const path = parsed.pathname.replace(/\/+$/, "");
	if (path === "" || path === "/") {
		parsed.pathname = "/v1";
	}
	return parsed.toString().replace(/\/+$/, "");
}

function joinUrl(base, suffix) {
	const trimmed = base.replace(/\/+$/, "");
	return trimmed + (suffix.startsWith("/") ? suffix : "/" + suffix);
}

function maskKey(key) {
	if (!key) return "(未填)";
	const text = String(key);
	if (text.length <= 10) return text.slice(0, 2) + "****";
	return `${text.slice(0, 6)}****${text.slice(-4)}`;
}

/** Auth carriers, tried in order. `query` exists for Google's native API. */
function authHeaders(key, scheme, api) {
	const headers = { accept: "application/json" };
	if (!key) return headers;
	if (scheme === "x-api-key") {
		headers["x-api-key"] = key;
		if (api === "anthropic") headers["anthropic-version"] = "2023-06-01";
	} else if (scheme === "query") {
		// carried in the URL, not the headers
	} else {
		headers.authorization = `Bearer ${key}`;
		if (api === "anthropic") headers["anthropic-version"] = "2023-06-01";
	}
	return headers;
}

function applyQueryKey(urlStr, key, scheme) {
	if (scheme !== "query" || !key) return urlStr;
	const url = new URL(urlStr);
	url.searchParams.set("key", key);
	return url.toString();
}

/** Non-chat model families that cannot answer a chat request. */
function isNonChatModel(id) {
	return /(^|[-_/])(embedding|embeddings|rerank|whisper|tts|moderation|image|audio|whisper-1|guard|reranker)([-_/]|$)/i.test(id);
}

const PREFERRED_MODEL_PATTERNS = [
	/^gpt-4o-mini$/i,
	/^gpt-4\.1-mini$/i,
	/^gpt-4o$/i,
	/^gpt-4-mini$/i,
	/^deepseek-chat$/i,
	/^claude-3-5-haiku/i,
	/^gemini-.*-flash$/i,
	/^qwen.*$/i,
];

/**
 * Choose a model to talk to. An explicit choice always wins; otherwise prefer a
 * small/fast family (probe cost should stay low) and skip embeddings-class ids
 * that would 400 on a chat request.
 */
export function pickModel(configured, names) {
	if (configured && configured.trim() !== "") return { model: configured.trim(), auto: false };
	const usable = names.filter((name) => typeof name === "string" && name.trim() !== "" && !isNonChatModel(name));
	if (usable.length === 0) return { model: "", auto: false };
	for (const pattern of PREFERRED_MODEL_PATTERNS) {
		const hit = usable.find((name) => pattern.test(name));
		if (hit) return { model: hit, auto: true };
	}
	return { model: [...usable].sort()[0], auto: true };
}

/** Levenshtein distance, abandoned early once it exceeds `max`. */
function editDistance(a, b, max) {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i += 1) {
		const row = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
			if (row[j] < rowMin) rowMin = row[j];
		}
		if (rowMin > max) return max + 1;
		prev = row;
	}
	return prev[b.length];
}

/**
 * Closest entry in `names` to what the user typed, for a "did you mean" hint.
 *
 * Case-insensitive equality is checked first because providers are wildly
 * inconsistent about capitalisation (SenseNova-Lite vs sensenova-lite), and that
 * alone already fixes most real typos. Only then fall back to edit distance.
 */
export function nearestModelName(input, names) {
	const want = String(input ?? "").trim().toLowerCase();
	if (want === "" || !Array.isArray(names) || names.length === 0) return null;
	const lowered = names.filter((n) => typeof n === "string" && n.trim() !== "").map((n) => [n, n.toLowerCase()]);
	const exact = lowered.find(([, low]) => low === want);
	if (exact) return exact[0];
	let best = null;
	let bestScore = Infinity;
	for (const [original, low] of lowered) {
		const score = editDistance(want, low, 4);
		if (score < bestScore) {
			bestScore = score;
			best = original;
		}
	}
	// A long shared name with a few edits apart is a coincidence, not a near miss.
	return bestScore <= 4 ? best : null;
}

/** CJK runs cost about one token per char; latin about four chars per token. */
export function estimateTokens(text) {
	if (!text) return 0;
	const cjk = (text.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g) || []).length;
	const rest = text.length - cjk;
	return Math.max(1, Math.round(cjk + rest / 4));
}

// ---------------------------------------------------------------------------
// payload / content extraction
// ---------------------------------------------------------------------------

function buildChatRequest(cfg, model, stream) {
	if (cfg.api === "anthropic") {
		return {
			url: joinUrl(cfg.base, "/messages"),
			body: {
				model,
				max_tokens: cfg.maxTokens,
				stream,
				messages: [{ role: "user", content: cfg.prompt }],
			},
		};
	}
	if (cfg.api === "gemini") {
		const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
		return {
			url: joinUrl(cfg.base, `/models/${encodeURIComponent(model)}:${action}`),
			body: {
				contents: [{ role: "user", parts: [{ text: cfg.prompt }] }],
				generationConfig: { maxOutputTokens: cfg.maxTokens },
			},
		};
	}
	return {
		url: joinUrl(cfg.base, "/chat/completions"),
		body: {
			model,
			max_tokens: cfg.maxTokens,
			stream,
			messages: [{ role: "user", content: cfg.prompt }],
		},
	};
}

/** Visible text carried by one streamed chunk, per provider dialect. */
function extractDelta(obj, api) {
	if (api === "anthropic") {
		if (obj.type !== "content_block_delta") return "";
		return typeof obj.delta?.text === "string" ? obj.delta.text : "";
	}
	if (api === "gemini") {
		const parts = obj.candidates?.[0]?.content?.parts;
		if (!Array.isArray(parts)) return "";
		let text = "";
		for (const part of parts) if (typeof part.text === "string") text += part.text;
		return text;
	}
	const choice = obj.choices?.[0];
	if (!choice) return "";
	if (typeof choice.delta?.content === "string") return choice.delta.content;
	if (typeof choice.message?.content === "string") return choice.message.content;
	if (typeof choice.text === "string") return choice.text;
	return "";
}

function extractText(obj, api) {
	if (api === "anthropic") {
		const parts = obj.content;
		if (!Array.isArray(parts)) return "";
		let text = "";
		for (const part of parts) if (typeof part.text === "string") text += part.text;
		return text;
	}
	if (api === "gemini") {
		const parts = obj.candidates?.[0]?.content?.parts;
		if (!Array.isArray(parts)) return "";
		let text = "";
		for (const part of parts) if (typeof part.text === "string") text += part.text;
		return text;
	}
	const content = obj.choices?.[0]?.message?.content;
	return typeof content === "string" ? content : "";
}

function extractUsage(obj) {
	const usage = obj.usage;
	if (usage && typeof usage.completion_tokens === "number") return usage.completion_tokens;
	if (usage && typeof usage.output_tokens === "number") return usage.output_tokens;
	const meta = obj.usageMetadata;
	if (meta && typeof meta.candidatesTokenCount === "number") return meta.candidatesTokenCount;
	return null;
}

// ---------------------------------------------------------------------------
// error translation
// ---------------------------------------------------------------------------

/**
 * Turn a transport error or an HTTP status into something a non-engineer can
 * act on. `status === 0` means the request never produced a response.
 */
export function diagnose({ status, errorText, cfg, model, phase, trace }) {
	const detail = String(errorText ?? "");
	// No HTTP status at all. The phase says exactly which step died, which is
	// strictly more informative than "no response" — and it is the difference
	// between "the request never left the machine" and "the request was sent and
	// the provider went quiet", two things a user must never be told as one.
	if (status <= 0 && phase) {
		const bytes = trace && Number.isFinite(trace.sentBytes) ? trace.sentBytes : null;
		const sentLine = bytes === null ? "请求正文" : `${bytes} 字节的请求正文`;
		const map = {
			connect: {
				level: "bad",
				title: "连不上服务器，请求根本没发出去",
				detail: "TCP 连接都没建起来，因此没有任何请求发到服务商。",
				hint: "这跟 Key 无关。检查网络/防火墙/公司网络限制；确认域名和端口没写错。",
			},
			proxy: {
				level: "bad",
				title: "连不上代理服务器，请求根本没发出去",
				detail: "没能通过你填的代理建立连接。",
				hint: "检查「高级设置」里的代理地址是否正确、代理软件是否在运行；不需要代理就把它清空。",
			},
			tls: {
				level: "bad",
				title: "TLS 加密握手失败，请求根本没发出去",
				detail: "TCP 通了，但加密握手没能完成，所以请求没有送出。",
				hint: "常见于证书过期、被中间设备拦截、或线路要求走代理。可勾选「忽略证书错误」再试一次确认。",
			},
			write: {
				level: "bad",
				title: "连接通了，但请求没能写出去",
				detail: "连接是活的，往这条连接里写请求时失败了。",
				hint: "多半是连接被中途掐断。换个网络（手机热点）重试一次，或在「高级设置」填上代理。",
			},
			closed: {
				level: "bad",
				title: "请求已发出，但服务商立刻断开连接",
				detail: `连接建立成功、${sentLine}也已写出，对端却一个字节的回应都没给就把连接关了。`,
				hint: "常见于被网关/WAF 拦截、该线路需要特定代理、Key 被限流封禁，或地址需要不同的线路。试试「高级设置」填代理；仍不行就换一家或联系服务商。",
			},
			"wait-status": {
				level: "bad",
				title: "请求已发出，但服务端一直没回应",
				detail: `${sentLine}已经写进连接发出去了，服务商连 HTTP 状态行都没返回，一直等到超时。`,
				hint: "请求确实送出去了，这不是「没调用」。多半是线路被墙/需要走代理、服务端卡住，或上游在排队。在「高级设置」填上代理再试一次；也可把超时调大试试。",
			},
			"wait-first-token": {
				level: "bad",
				title: "连上了、状态也是 200，但一直等不到正文",
				detail: "服务端接受了请求并返回 200，却在超时内一个 token 都没吐出来。",
				hint: "通常是上游模型排队或卡死。等几十秒重试；连续几次都这样说明这条线路不稳定。",
			},
		};
		const hit = map[phase];
		if (hit) return { ...hit, status, phase };
	}
	if (status > 0) {
		// 2xx 里出错是最容易被误报的一类：网关接受了请求却没吐出正文。服务商
		// 自己给的那句错误信息远比状态码有用，绝不能被"意料之外的状态码"盖掉。
		if (status >= 200 && status < 300) {
			if (/正文都没返回/.test(detail)) {
				return {
					level: "bad",
					title: "返回 200，但内容是空的",
					detail: "网络通、鉴权过、服务端也回了 200，可整个响应里没有一个字的正文。",
					hint: "常见三种原因：① 触发了服务商的内容风控 —— 上面「测试提示词」换个中性点的说法再试一次；② 模型名不被认可但被网关静默吞掉 —— 在「模型名」里换成模型列表里确有的那个；③ 中转站上游失败后拿 200 空包糊弄你，这种得换一家。",
				};
			}
			const provider = detail.trim();
			if (provider) {
				// 优先翻译服务商自己说的话：它比任何通用文案都准。
				const rule = [
					[/余额|欠费|额度|quota|billing|insufficient|arrears/i, "欠费或额度用尽", "Key 是对的，但这个账户没钱了或套餐用完了。去服务商后台充值。"],
					[/模型.{0,6}(不存在|不存在于|无效)|model.{0,10}(not found|not exist|invalid|unsupported)|no such model/i, "模型名不被认可", "Key 和地址都对，问题出在模型名。去服务商官网核对确切写法（大小写、前缀、有没有 -latest 之类的后缀）。"],
					[/权限|无权|permission|forbidden|not allowed|unauthorized/i, "这个 Key 没有调用权限", "Key 本身有效，但所属账号没开通这个模型，或者没做地区授权。"],
					[/风控|审核|敏感|违规|content.?filter|safety|moderation/i, "内容被风控拦了", "响应本身是空的，但请求撞上了服务商的内容审核。换一个中性提示词，或换个模型再试。"],
					[/超时|timeout|overloaded|rate.?limit/i, "服务端处理不过来", "上游当时正忙或超时了。等几十秒重试一次；连续几次都这样说明这条线路不稳。"],
				];
				for (const [re, title, hint] of rule) {
					if (re.test(provider)) return { level: "bad", title, detail: `服务商返回：${provider.slice(0, 300)}`, hint };
				}
				return {
					level: "bad",
					title: "回 200，但没拿到内容",
					detail: `服务商返回：${provider.slice(0, 300)}`,
					hint: "状态码是成功的，说明地址和 Key 都通。上面是服务商自己给的错误信息，按它说的处理即可。",
				};
			}
			return {
				level: "bad",
				title: "回 200，但没拿到内容",
				detail: `服务端返回 ${status}，但响应里没有可用的正文。`,
				hint: "状态码是成功的，说明地址和 Key 都通。换个模型名或提示词再试一次；一直这样，多半是这个中转站上游出问题了。",
			};
		}
		if (status === 401) {
			return {
				level: "bad",
				title: "Key 无效",
				detail: "服务端返回 401 Unauthorized。",
				hint: "Key 打错了、已过期、或者复制时少了几个字符。也可能这个 Key 属于另一个服务商。",
			};
		}
		if (status === 403) {
			return {
				level: "bad",
				title: "Key 有效，但没权限",
				detail: "服务端返回 403 Forbidden。",
				hint: "常见原因：Key 所属账号没有这个模型的权限，或者服务商做了地区限制（OpenAI / Anthropic / Gemini 都有）。",
			};
		}
		if (status === 404) {
			// Report what was actually requested and nothing more. Measured against
			// NVIDIA: /v1/chat/completions answers 405 (exists) while /chat/completions
			// answers 404 — so a 404 does mean "nothing at this path", but which path
			// is wrong (missing /v1, a relay prefix, a typo) is provider-specific and
			// guessing here just produces confident nonsense. normBase() already
			// appends /v1 to a bare host, so this cannot be the user's typo unless
			// their own address really lacks it.
			return {
				level: "bad",
				title: "这个地址上没有接口（404）",
				detail: `请求的是 ${cfg.base}/chat/completions，服务商返回 404。`,
				hint: "请对照该服务商的文档确认地址：有的要带 /v1，有的要带 /compatible-mode/v1 之类的前缀，中转站还有自己的规则。地址和模型名都取自服务商官方说明最稳妥。",
			};
		}
		if (status === 429) {
			return {
				level: "bad",
				title: "Key 有效，但被限流或欠费",
				detail: "服务端返回 429 Too Many Requests。",
				hint: "这是最容易被误判的一种：它说明 Key 是对的。多数中转站 429 的真实含义是余额不足或套餐用尽，也有确实是并发超限的。",
			};
		}
		if (status === 400) {
			return {
				level: "bad",
				title: "请求被拒绝",
				detail: "服务端返回 400 Bad Request。",
				hint: model
					? `多半是模型名 "${model}" 这个服务商不认，或者该模型不支持流式输出。去服务商官网核对一下模型名。`
					: "多半是请求格式和这个服务商的方言对不上，换一个服务商预设试试。",
			};
		}
		if (status === 402) {
			return {
				level: "bad",
				title: "欠费",
				detail: "服务端返回 402 Payment Required。",
				hint: "Key 是有效的，账户没钱了。",
			};
		}
		if (status >= 500) {
			return {
				level: "bad",
				title: "服务商自己出问题了",
				detail: `服务端返回 ${status}。`,
				hint: "这不是你的问题，也通常不是 Key 的问题。等一会儿再试，或者换一家中转站。",
			};
		}
		return {
			level: "bad",
			title: `意料之外的状态码 ${status}`,
			detail,
			hint: "",
		};
	}

	// No response at all — this is a network-layer failure.
	if (/ENOTFOUND|EAI_AGAIN/i.test(detail)) {
		return {
			level: "bad",
			title: "域名解析不了",
			detail: detail.split("\n")[0],
			hint: "地址可能拼错了，或者这台机器的 DNS 有问题。换个地址验证一下。",
		};
	}
	if (/ECONNREFUSED/i.test(detail)) {
		return {
			level: "bad",
			title: "服务商拒绝连接",
			detail: detail.split("\n")[0],
			hint: "端口上没有服务在听。地址或端口写错了，或者服务商那边服务没启动。",
		};
	}
	if (/ETIMEDOUT|超时/i.test(detail)) {
		return {
			level: "bad",
			title: "连不上（超时）",
			detail: detail.split("\n")[0],
			hint: cfg.proxy
				? "代理配了但没通。检查代理地址和端口。"
				: "多半是需要走代理却直连。展开「高级设置」填上代理，再试一次。",
		};
	}
	if (/CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|self.signed|altnames/i.test(detail)) {
		return {
			level: "bad",
			title: "证书有问题",
			detail: detail.split("\n")[0],
			hint: "证书过期、域名对不上，或被中间设备劫持了。别在证书出问题的连接上输入 Key。",
		};
	}
	if (/proxy|ECONNRESET|socket hang up/i.test(detail)) {
		return {
			level: "bad",
			title: "连接被中断",
			detail: detail.split("\n")[0],
			hint: "如果配了代理，多半是代理本身有问题；没配代理则可能是服务商主动断开了连接。",
		};
	}
	return {
		level: "bad",
		title: "请求失败",
		detail: detail.split("\n")[0] || "未知错误",
		hint: "",
	};
}

// ---------------------------------------------------------------------------
// stage 1 — network
// ---------------------------------------------------------------------------

async function probeNetwork(cfg, emit) {
	const checks = [];
	const add = (id, label, status, detail, techDetail, ms) => {
		const entry = { id, label, status, detail, techDetail: techDetail ?? null, ms: ms === undefined ? null : Math.round(ms) };
		checks.push(entry);
		emit({ type: "check", ...entry });
		return entry;
	};

	const url = new URL(cfg.base);
	const secure = url.protocol === "https:";
	const port = url.port ? Number(url.port) : secure ? 443 : 80;

	// DNS
	let dnsOk = false;
	let dnsMs = 0;
	try {
		const started = performance.now();
		const result = await withTimeout(dnsLookup(url.hostname), 5000, "DNS 查询超时（5s）");
		dnsMs = performance.now() - started;
		dnsOk = true;
		add("dns", "域名解析", "ok", "域名解析成功", `${url.hostname} → ${result.address}`, dnsMs);
	} catch (error) {
		add("dns", "域名解析", "fail", error.message, null, 0);
		add("tcp", "端口连通", "skip", "域名都解析不了，跳过", null, null);
		if (secure) add("tls", "TLS 握手", "skip", "域名都解析不了，跳过", null, null);
		return { ok: false, checks };
	}

	// TCP
	let socket = null;
	let tcpMs = 0;
	try {
		const started = performance.now();
		socket = await withTimeout(
			cfg.proxy
				? connectTunnel({ proxyUrl: cfg.proxy, host: url.hostname, port, timeoutMs: cfg.timeout })
				: tcpConnect({ host: url.hostname, port, timeoutMs: cfg.timeout }),
			cfg.timeout + 500,
			"连接超时",
		);
		tcpMs = performance.now() - started;
		add("tcp", "端口连通", "ok", cfg.proxy ? `经代理连到 ${url.hostname}:${port}` : `${url.hostname}:${port} 接通`, null, tcpMs);
	} catch (error) {
		const info = diagnose({ status: 0, errorText: error.message, cfg });
		add("tcp", "端口连通", "fail", info.title, null, 0);
		// 无论是否 https 都补上 TLS 行：小白用户看到「少了一项」比看到「已跳过」更困惑。
		add("tls", "TLS 握手", "skip", secure ? "TCP 都没通，跳过" : "http 明文地址，无需握手；连接已失败", null, null);
		return { ok: false, checks };
	}

	// TLS
	if (!secure) {
		// 标 skip 而不是 ok：没加密就是没加密，给个绿勾会让人误以为连接是安全的。
		add("tls", "TLS 握手", "skip", "你填的是 http:// 明文地址，不加密，仅建议本机或内网使用", null, 0);
		socket.destroy();
		return { ok: true, checks };
	}

	let certDays = null;
	try {
		const started = performance.now();
		const secureSocket = await withTimeout(
			tlsUpgrade(socket, url.hostname, cfg.insecure === true, cfg.timeout),
			cfg.timeout + 500,
			"TLS 握手超时",
		);
		const tlsMs = performance.now() - started;
		const cert = typeof secureSocket.getPeerCertificate === "function" ? secureSocket.getPeerCertificate() : null;
		if (cert && cert.valid_to) {
			certDays = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
		}
		secureSocket.destroy();
		if (certDays !== null && certDays < 0) {
			add("tls", "TLS 握手", "fail", `握手成功，但证书 ${certDays} 天前就过期了`, null, tlsMs);
			return { ok: false, checks };
		}
		if (certDays !== null && certDays < 15) {
			add("tls", "TLS 握手", "warn", `握手成功；证书 ${certDays} 天后过期（建议尽快换）`, null, tlsMs);
		} else if (certDays !== null) {
			add("tls", "TLS 握手", "ok", `握手成功，证书还有 ${certDays} 天`, null, tlsMs);
		} else {
			add("tls", "TLS 握手", "ok", "握手成功", null, tlsMs);
		}
	} catch (error) {
		try {
			socket.destroy();
		} catch {
			/* already torn down */
		}
		add("tls", "TLS 握手", "fail", error.message.split("\n")[0], null, 0);
		return { ok: false, checks };
	}

	return { ok: true, checks };
}

// ---------------------------------------------------------------------------
// stage 2 — auth + model discovery
// ---------------------------------------------------------------------------

function parseModels(text) {
	try {
		const parsed = JSON.parse(text);
		const list = parsed?.data ?? parsed?.models ?? [];
		if (!Array.isArray(list)) return [];
		const names = [];
		for (const item of list) {
			if (typeof item === "string") names.push(item);
			else if (typeof item?.id === "string") names.push(item.id);
			else if (typeof item?.name === "string") names.push(item.name);
		}
		return names;
	} catch {
		return [];
	}
}

async function discover(cfg, emit) {
	const checks = [];
	const add = (id, label, status, detail) => {
		const entry = { id, label, status, detail, ms: null };
		checks.push(entry);
		emit({ type: "check", ...entry });
		return entry;
	};

	const schemes = cfg.key
		? cfg.api === "anthropic"
			? ["x-api-key", "bearer"]
			: ["bearer", "x-api-key", "query"]
		: ["bearer"];
	const failures = [];

	for (const scheme of schemes) {
		const target = applyQueryKey(joinUrl(cfg.base, "/models"), cfg.key, scheme);
		let url;
		try {
			url = new URL(target);
		} catch {
			add("auth", "鉴权", "fail", "地址无法解析", null);
			return { ok: false, scheme: null, models: [], checks, failures };
		}
		try {
			const started = performance.now();
			const socket = await establish(url, cfg, cfg.timeout);
			const { response } = await sendRequest({
				url,
				socket,
				cfg,
				method: "GET",
				headers: authHeaders(cfg.key, scheme, cfg.api),
				timeoutMs: cfg.timeout,
			});
			const text = await readAll(response);
			socket.destroy();
			const ms = Math.round(performance.now() - started);
			const status = response.statusCode ?? 0;

			if (status === 200) {
				const models = parseModels(text);
				const shown = schemes.length > 1 ? `（用 ${scheme === "bearer" ? "Authorization: Bearer" : scheme === "x-api-key" ? "x-api-key 头" : "URL 参数"} 方式通过）` : "";
				add(
					"auth",
					"鉴权",
					"ok",
					cfg.key ? `Key 有效${shown}` : `这个地址不需要 Key${shown}`,
					ms,
				);
				add("models", "模型列表", models.length > 0 ? "ok" : "warn", models.length > 0 ? `能列出 ${models.length} 个模型` : "连上了，但这个地址不提供模型列表", ms);
				return { ok: true, scheme, models, checks, failures };
			}
			if (status === 404) {
				failures.push({ scheme, status, text });
				add("auth", "鉴权", "fail", "地址返回 404，见下方提示", ms);
				return {
					ok: false,
					scheme: null,
					models: [],
					checks,
					failures,
					hardStop: true,
				};
			}
			failures.push({ scheme, status, text });
		} catch (error) {
			failures.push({ scheme, status: 0, text: error.message, phase: error.probePhase ?? null, trace: error.probeTrace ?? null });
		}
	}

	const last = failures[failures.length - 1];
	const info = diagnose({ status: last?.status ?? 0, errorText: last?.text ?? "所有鉴权方式都失败", cfg, phase: last?.phase ?? null, trace: last?.trace ?? null });
	add("auth", "鉴权", "fail", `${info.title} — ${info.detail}`, null);
	return { ok: false, scheme: null, models: [], checks, failures, diagnosis: info };
}

// ---------------------------------------------------------------------------
// stage 3+4 — one streaming call, and the repeated benchmark
// ---------------------------------------------------------------------------

/**
 * One streaming completion, timed. TTFT is measured to the first *visible*
 * content delta, which is what a user actually waits for — a reasoning trace
 * arriving first does not make the answer appear sooner.
 */
async function streamCall(cfg, model, scheme) {
	const { url: rawUrl, body } = buildChatRequest(cfg, model, true);
	const url = new URL(applyQueryKey(rawUrl, cfg.key, scheme));
	const payload = JSON.stringify(body);
	const started = performance.now();
	let text = "";
	let ttftMs = null;
	let usage = null;
	let firstStatus = null;
	let sawError = null;
	let trace = null;
	// How many separate content-bearing payloads actually arrived. A vendor that
	// genuinely streams produces many; a gateway that buffers (or a provider that
	// effectively answers non-streaming) produces one, and then there is no
	// generation rate to measure — only the arrival pattern.
	let deltaCount = 0;
	const failed = (error, extra) => ({
		ok: false,
		status: firstStatus ?? 0,
		error: error.message,
		phase: error.probePhase ?? "wait-first-token",
		trace: error.probeTrace ?? null,
		ttftMs,
		totalMs: Math.round(performance.now() - started),
		text,
		...extra,
	});

	try {
		const socket = await establish(url, cfg, cfg.timeout);
		const sent = await sendRequest({
			url,
			socket,
			cfg,
			method: "POST",
			headers: {
				...authHeaders(cfg.key, scheme, cfg.api),
				"content-type": "application/json",
				accept: "text/event-stream",
			},
			body: payload,
			timeoutMs: cfg.timeout,
		});
		const { request, response } = sent;
		trace = sent.trace;
		firstStatus = response.statusCode ?? 0;

		if (firstStatus !== 200) {
			const errText = await readAll(response);
			socket.destroy();
			return { ok: false, status: firstStatus, error: errText, phase: "status", trace, ttftMs: null, totalMs: Math.round(performance.now() - started), text: "" };
		}

		for await (const line of ssePayloads(response)) {
			if (line === "[DONE]") break;
			let obj;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}
			if (obj.error) {
				sawError = typeof obj.error === "string" ? obj.error : JSON.stringify(obj.error);
				break;
			}
			const tokenCount = extractUsage(obj);
			if (tokenCount !== null) usage = tokenCount;
			const delta = extractDelta(obj, cfg.api);
			if (delta !== "") {
				if (ttftMs === null) ttftMs = performance.now() - started;
				text += delta;
				deltaCount += 1;
			}
		}
		try {
			request.destroy();
			socket.destroy();
		} catch {
			/* already closed */
		}
	} catch (error) {
		return failed(error);
	}

	const totalMs = performance.now() - started;
	if (sawError) {
		return { ok: false, status: firstStatus ?? 0, error: sawError, phase: "status", trace, ttftMs, totalMs: Math.round(totalMs), text };
	}
	if (ttftMs === null) {
		return {
			ok: false,
			status: firstStatus ?? 0,
			error: "服务端连上了、状态也是 200，但一个字的正文都没返回",
			phase: "empty",
			trace,
			ttftMs: null,
			totalMs: Math.round(totalMs),
			text,
			empty: true,
		};
	}
	const tokens = usage ?? estimateTokens(text);
	const generateMs = Math.max(1, totalMs - ttftMs);
	// Output speed is a property of how the model GENERATED, so it is only
	// measurable across several deliveries. One payload means the whole answer
	// arrived at once: the window collapses to a few milliseconds and the ratio
	// explodes into a number no model could have produced (measured: 35000 "字/秒"
	// for the same text that streams at 55). Reporting that — and grading it
	// "很好" — would be the tool asserting something it has no evidence for, so
	// it reports nothing instead.
	const measurable = deltaCount >= 2;
	return {
		ok: true,
		status: firstStatus ?? 0,
		phase: "done",
		trace,
		text,
		ttftMs: Math.round(ttftMs),
		totalMs: Math.round(totalMs),
		tokens,
		tps: measurable ? tokens / (generateMs / 1000) : null,
		deltaCount,
		streamed: measurable,
		usageEstimated: usage === null,
	};
}

/** Where the request died, in words a non-engineer can act on. */
export function explainPhase(sample) {
	const phase = sample?.phase;
	const trace = sample?.trace ?? null;
	const sentBytes = trace && Number.isFinite(trace.sentBytes) ? trace.sentBytes : null;
	if (phase === "connect") return "卡在第一步：TCP 连接就没建起来，请求一个字节都没发出去。";
	if (phase === "proxy") return "卡在第一步：连代理服务器失败，请求一个字节都没发出去。";
	if (phase === "tls") return "卡在第二步：TCP 通了但 TLS 加密握手失败，请求一个字节都没发出去。";
	if (phase === "write") return "卡在第三步：连接是通的，但请求没能写进这条连接。";
	if (phase === "closed") return "请求写出去了，但对端一个字节的回应都没给就把连接关了。";
	if (phase === "wait-status") {
		const howMuch = sentBytes === null ? "请求正文" : `${sentBytes} 字节的请求正文`;
		return `卡在第四步：${howMuch}已经发出去了，服务商连 HTTP 状态行都没回。`;
	}
	if (phase === "wait-first-token") return "连接正常、状态也是 200，但正文一个 token 都没等到。";
	if (phase === "empty") return "状态是 200、正文也读完了，但里面没有模型说的话。";
	if (phase === "status") return `服务商回话了，状态码 ${sample?.status ?? "未知"}。`;
	if (phase === "done") return "请求成功走完，模型正常吐字了。";
	return "";
}

/** Run `rounds` calls with at most `concurrency` in flight; never throws. */
async function bench(cfg, model, scheme, rounds, concurrency) {
	const results = [];
	let cursor = 0;
	const workers = [];
	for (let worker = 0; worker < Math.min(concurrency, rounds); worker += 1) {
		workers.push(
			(async () => {
				for (;;) {
					const index = cursor;
					cursor += 1;
					if (index >= rounds) return;
					try {
						results.push(await streamCall(cfg, model, scheme));
					} catch (error) {
						results.push({ ok: false, status: 0, error: error.message, ttftMs: null, totalMs: 0, text: "" });
					}
				}
			})(),
		);
	}
	await Promise.all(workers);

	const successes = results.filter((r) => r.ok);
	const ttfts = successes.map((r) => r.ttftMs).filter((v) => typeof v === "number");
	const tpss = successes.map((r) => r.tps).filter((v) => typeof v === "number");
	const avg = (list) => (list.length === 0 ? null : list.reduce((a, b) => a + b, 0) / list.length);
	const median = (list) => {
		if (list.length === 0) return null;
		const sorted = [...list].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
	};
	return {
		runs: results,
		attempts: rounds,
		successes: successes.length,
		successRate: rounds === 0 ? 0 : successes.length / rounds,
		ttftAvg: avg(ttfts),
		ttftMedian: median(ttfts),
		tpsAvg: avg(tpss),
		tpsMedian: median(tpss),
		failures: results.filter((r) => !r.ok).map((r) => ({ status: r.status, error: r.error, phase: r.phase ?? null, where: explainPhase(r) })),
	};
}

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

function gradeTtft(ms) {
	if (ms === null) return "none";
	if (ms < 500) return "good";
	if (ms < 1200) return "fair";
	if (ms < 2500) return "slow";
	return "bad";
}

function gradeTps(tps) {
	if (tps === null) return "none";
	if (tps >= 45) return "good";
	if (tps >= 20) return "fair";
	if (tps >= 8) return "slow";
	return "bad";
}

function gradeRate(rate) {
	if (rate === null) return "none";
	if (rate >= 1) return "good";
	if (rate >= 0.95) return "fair";
	if (rate >= 0.8) return "slow";
	return "bad";
}

/**
 * Flatten a diagnosis into verdict reason lines. The verdict banner is the part
 * of the report a beginner actually reads, so it carries the actionable hint —
 * a bare title like "意料之外的状态码 200" tells them nothing about what to do.
 */
function reasonLines(info, fallback) {
	if (!info) return [fallback];
	const lines = [info.title];
	if (info.hint) lines.push(info.hint);
	return lines;
}

/**
 * One sentence plus the reasons behind it. The three headline numbers are only
 * meaningful together — a beautiful TTFT on a 60%-success line reads as fast
 * in a demo and as unusable in production, so the verdict refuses to call that
 * a good API.
 */
function buildVerdict(state) {
	const { network, auth, sample, speed } = state;
	const reasons = [];

	if (!network.ok) {
		return { level: "bad", headline: "连不上：网络这关就没过", reasons: ["先把网络/DNS/证书这层解决，Key 还没轮到检验。"] };
	}
	if (!auth.ok) {
		return { level: "bad", headline: "网络没问题，Key 或模型不对", reasons: reasonLines(auth.diagnosis, "鉴权失败。") };
	}
	if (!sample || !sample.ok) {
		const info = sample?.error
			? diagnose({ status: sample.status, errorText: sample.error, cfg: state.cfg, model: state.model, phase: sample.phase, trace: sample.trace })
			: null;
		// "调不动模型" is an accusation the probe may not be entitled to make: it
		// may simply be that the request never reached anyone, or that the server
		// went quiet. Say which one was actually observed.
		const headline = !info
			? "Key 有效，但这次没测出结果"
			: info.phase === "wait-status" || info.phase === "closed"
				? "Key 有效，请求确实发出去了，但服务端没回话"
				: info.phase === "connect" || info.phase === "proxy" || info.phase === "tls" || info.phase === "write"
					? "Key 有效，但请求根本没送到服务商手上"
					: "Key 有效，但实际调不动模型";
		const reasons = reasonLines(info, "连通性测试失败。");
		const where = explainPhase(sample);
		if (where) reasons.push(where);
		return { level: "bad", headline, reasons };
	}

	const rate = speed.successRate;
	const ttft = speed.ttftMedian ?? sample.ttftMs;
	const tps = speed.tpsMedian ?? sample.tps;
	const streamed = sample.streamed ?? true;

	if (rate < 0.8) {
		reasons.push(`成功率只有 ${(rate * 100).toFixed(0)}%（${speed.successes}/${speed.attempts}），线上会频繁失败。`);
	}
	if (ttft !== null && ttft >= 1200) {
		reasons.push(`首字要等 ${Math.round(ttft)}ms，等待感明显。`);
	}
	if (tps !== null && tps < 20) {
		reasons.push(`输出速度只有 ${tps.toFixed(1)} 字/秒，读起来会逐字蹦。`);
	}
	if (!streamed) {
		// Say this out loud rather than letting a missing metric read as a good
		// one: an unmeasured speed is not a fast one.
		reasons.push("响应是整块返回的，测不出逐字输出速度——首字延迟仍可信。");
	}
	if (reasons.length === 0) {
		// Reached only when nothing raised a flag. ttft is guaranteed non-null
		// here (sample.ok implies real output), but tps may legitimately be null
		// when the vendor answered in one piece, so it needs its own wording
		// instead of a `.toFixed()` on nothing.
		reasons.push(
			tps === null
				? `首字 ${Math.round(ttft)}ms、成功率 ${(rate * 100).toFixed(0)}%，都在舒服的区间；输出速度这次没测到。`
				: `首字 ${Math.round(ttft)}ms、输出 ${tps.toFixed(1)} 字/秒、成功率 ${(rate * 100).toFixed(0)}%，三项都在舒服的区间。`,
		);
	}

	let level;
	let headline;
	if (rate >= 0.95 && ttft !== null && ttft < 800 && tps !== null && tps >= 20) {
		level = "good";
		headline = "好用，可以放心用";
	} else if (rate >= 0.8 && ttft !== null && ttft < 1800) {
		level = "ok";
		headline = "能用，但不算快";
	} else if (rate >= 0.8) {
		level = "slow";
		headline = "能用，但是慢";
	} else {
		level = "bad";
		headline = "不建议上生产";
	}
	return { level, headline, reasons };
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

function readConfig(body) {
	const base = normBase(body.base);
	const timeoutMs = Number(body.timeout);
	const rounds = Number(body.rounds);
	const concurrency = Number(body.concurrency);
	return {
		base,
		key: typeof body.key === "string" ? body.key.trim() : "",
		model: typeof body.model === "string" ? body.model.trim() : "",
		api: ["openai", "anthropic", "gemini"].includes(body.api) ? body.api : "openai",
		timeout: Number.isFinite(timeoutMs) ? Math.min(120000, Math.max(3000, timeoutMs)) : 30000,
		maxTokens: Number.isFinite(Number(body.maxTokens)) ? Math.min(4096, Math.max(16, Number(body.maxTokens))) : 128,
		rounds: Number.isFinite(rounds) ? Math.min(10, Math.max(1, Math.round(rounds))) : 3,
		concurrency: Number.isFinite(concurrency) ? Math.min(5, Math.max(1, Math.round(concurrency))) : 1,
		prompt: typeof body.prompt === "string" && body.prompt.trim() !== "" ? body.prompt.trim() : DEFAULT_PROMPT,
		proxy: typeof body.proxy === "string" && body.proxy.trim() !== "" ? body.proxy.trim() : "",
		insecure: body.insecure === true,
	};
}

/**
 * The whole probe. `emit` is called for every check as it completes; the return
 * value is the same payload the client finally renders, so a client that
 * ignores the stream still gets a complete answer.
 */
export async function runProbe(cfg, emit) {
	// state 会原样回传浏览器并写进报告，cfg 里绝不能留明文 key；
	// diagnose() 只用到 cfg.proxy，所以这里直接换成打码副本。
	const state = { cfg: { ...cfg, key: maskKey(cfg.key) }, network: { ok: false, checks: [] }, auth: { ok: false, models: [], checks: [] }, sample: null, speed: null };

	if (!cfg.base) {
		return { ok: false, error: "请先填写 API 地址。", config: { base: "", keyMasked: maskKey(cfg.key), api: cfg.api, model: cfg.model }, stages: state };
	}
	let parsed;
	try {
		parsed = new URL(cfg.base);
	} catch {
		return { ok: false, error: `地址看不懂：${cfg.base}`, config: { base: cfg.base, keyMasked: maskKey(cfg.key), api: cfg.api, model: cfg.model }, stages: state };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, error: "地址必须以 http:// 或 https:// 开头。", config: { base: cfg.base, keyMasked: maskKey(cfg.key), api: cfg.api, model: cfg.model }, stages: state };
	}

	// Normalize the base URL to ensure it has /v1 if needed
	cfg.base = normBase(cfg.base);
	
	// 1 — network
	emit({ type: "stage", stage: "network", title: "检查网络" });
	state.network = await probeNetwork(cfg, emit);
	if (!state.network.ok) {
		const verdict = buildVerdict(state);
		return { ok: false, verdict, config: { base: cfg.base, keyMasked: maskKey(cfg.key), api: cfg.api, model: cfg.model }, stages: state };
	}

	// 2 — auth + model
	emit({ type: "stage", stage: "auth", title: "检查 Key 和模型" });
	state.auth = await discover(cfg, emit);
	if (!state.auth.ok) {
		if (state.auth.hardStop) {
			state.auth.diagnosis = diagnose({ status: 404, errorText: "", cfg });
		}
		const verdict = buildVerdict(state);
		return { ok: false, verdict, config: { base: cfg.base, keyMasked: maskKey(cfg.key), api: cfg.api, model: cfg.model }, stages: state };
	}

	const picked = pickModel(cfg.model, state.auth.models);
	if (!picked.model) {
		state.auth.diagnosis = {
			level: "bad",
			title: "没法确定用哪个模型",
			detail: state.auth.models.length === 0 ? "这个地址没有提供模型列表。" : `列出来的模型都不是对话模型（${state.auth.models.slice(0, 3).join(", ")}…）。`,
			hint: "在上方「模型名」里手动填一个这个服务商支持的对话模型。",
		};
		const verdict = buildVerdict(state);
		return { ok: false, verdict, config: { base: cfg.base, keyMasked: maskKey(cfg.key), api: cfg.api, model: "" }, stages: state };
	}
	state.model = picked.model;
	state.modelAuto = picked.auto;
	// A misspelled model name otherwise surfaces much later as an opaque 400 from
	// the chat endpoint. The provider already told us what it has — say it now.
	const known = state.auth.models;
	const notListed = !picked.auto && known.length > 0 && !known.includes(picked.model);
	const nearMiss = notListed ? nearestModelName(picked.model, known) : null;
	state.modelNotice = notListed
		? nearMiss
			? `你填的「${picked.model}」不在服务商列出的 ${known.length} 个模型里，可能拼错了。服务商有「${nearMiss}」。`
			: `你填的「${picked.model}」不在服务商列出的 ${known.length} 个模型里，可能拼错了——用下面的「服务商提供的模型」里点一个试试。`
		: null;
	emit({ type: "model", model: picked.model, auto: picked.auto, notice: state.modelNotice });
	if (state.auth.models.length > 0) {
		emit({ type: "models", models: state.auth.models });
	}

	// 3 — one live call
	emit({ type: "stage", stage: "probe", title: "试一次真实对话" });
	state.sample = await streamCall(cfg, picked.model, state.auth.scheme);
	emit({ type: "sample", ok: state.sample.ok, ttftMs: state.sample.ttftMs ?? null, totalMs: state.sample.totalMs ?? null, tps: state.sample.tps ?? null, tokens: state.sample.tokens ?? null, deltaCount: state.sample.deltaCount ?? 0, streamed: state.sample.streamed ?? false, text: (state.sample.text ?? "").slice(0, 400), status: state.sample.status ?? 0, error: state.sample.error ?? null, phase: state.sample.phase ?? null, where: explainPhase(state.sample) });
	if (!state.sample.ok) {
		state.sample.diagnosis = diagnose({ status: state.sample.status, errorText: state.sample.error, cfg, model: picked.model, phase: state.sample.phase, trace: state.sample.trace });
		const verdict = buildVerdict(state);
		return { ok: false, verdict, config: { base: cfg.base, keyMasked: maskKey(cfg.key), api: cfg.api, model: picked.model }, stages: state };
	}

	// 4 — repeat for stability
	emit({ type: "stage", stage: "speed", title: `连测 ${cfg.rounds} 次看稳定性` });
	state.speed = await bench(cfg, picked.model, state.auth.scheme, cfg.rounds, cfg.concurrency);
	emit({
		type: "metrics",
		successRate: state.speed.successRate,
		successes: state.speed.successes,
		attempts: state.speed.attempts,
		ttftMedian: state.speed.ttftMedian,
		ttftAvg: state.speed.ttftAvg,
		ttftGrade: gradeTtft(state.speed.ttftMedian),
		tpsMedian: state.speed.tpsMedian,
		tpsAvg: state.speed.tpsAvg,
		tpsGrade: gradeTps(state.speed.tpsMedian),
		rateGrade: gradeRate(state.speed.successRate),
		failures: state.speed.failures,
	});

	const verdict = buildVerdict(state);
	return {
		ok: verdict.level !== "bad",
		verdict,
		metrics: {
			ttftMedian: state.speed.ttftMedian,
			ttftAvg: state.speed.ttftAvg,
			ttftGrade: gradeTtft(state.speed.ttftMedian),
			tpsMedian: state.speed.tpsMedian,
			tpsAvg: state.speed.tpsAvg,
			tpsGrade: gradeTps(state.speed.tpsMedian),
			successRate: state.speed.successRate,
			rateGrade: gradeRate(state.speed.successRate),
			successes: state.speed.successes,
			attempts: state.speed.attempts,
		},
		sample: { text: state.sample.text.slice(0, 400), ttftMs: state.sample.ttftMs, totalMs: state.sample.totalMs },
		config: { base: cfg.base, keyMasked: maskKey(cfg.key), api: cfg.api, model: picked.model, modelAuto: picked.auto, rounds: cfg.rounds, concurrency: cfg.concurrency },
		stages: state,
	};
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" };

function writeJson(res, status, body, headers = {}) {
	res.writeHead(status, { ...JSON_HEADERS, ...headers });
	res.end(JSON.stringify(body));
}

/** Bounded JSON body reader; destroys the request instead of draining overflow. */
async function readJsonBody(req, maxBytes = 64 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBytes) {
			req.destroy();
			return null;
		}
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return null;
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * POST /probe → NDJSON. One event per line, so the panel fills in live; the
 * final `result` event carries the same payload `runProbe` returned, which
 * makes the panel correct even if it only ever rendered the last line.
 */
async function handleProbe(ctx, req, res) {
	if (!isPairedOrLoopbackAllowed(ctx, req)) {
		writeJson(res, 403, { error: "forbidden: loopback-only" });
		return;
	}
	if (req.method !== "POST") {
		writeJson(res, 405, { error: `method not allowed: ${req.method}` });
		return;
	}
	const body = await readJsonBody(req);
	if (body === null) {
		writeJson(res, 400, { error: "invalid JSON body" });
		return;
	}
	const cfg = readConfig(body);

	res.writeHead(200, {
		"content-type": "application/x-ndjson; charset=utf-8",
		"cache-control": "no-store",
		"x-accel-buffering": "no",
		"referrer-policy": "no-referrer",
	});
	let closed = false;
	const emit = (event) => {
		if (closed) return;
		try {
			res.write(JSON.stringify(event) + "\n");
		} catch {
			closed = true;
		}
	};
	req.on("close", () => {
		closed = true;
	});

	try {
		const result = await runProbe(cfg, emit);
		emit({ type: "result", result });
	} catch (error) {
		ctx.logger?.warn?.(error);
		emit({ type: "result", result: { ok: false, error: error?.message ?? String(error), stages: {} } });
	}
	if (!closed) res.end();
}

function handleHealth(ctx, req, res) {
	if (!isPairedOrLoopbackAllowed(ctx, req)) {
		writeJson(res, 403, { error: "forbidden: loopback-only" });
		return;
	}
	if (req.method !== "GET") {
		writeJson(res, 405, { error: `method not allowed: ${req.method}` });
		return;
	}
	// No preset count here on purpose. The list lives in the client bundle, and
	// this route used to report a hardcoded 10 from a stale host-side copy that
	// disagreed with the 38 the panel actually offers.
	writeJson(res, 200, { ok: true, plugin: "api-probe" });
}

/**
 * Build the route list for one ctx.
 *
 * ROUTE_LIST must NOT be a module-level constant: its handlers close over
 * `ctx`, which only exists inside apply(). A top-level array would evaluate
 * fine and then throw `ReferenceError: ctx is not defined` on the first
 * request — the kind of bug unit tests on runProbe never see.
 * @param ctx - host plugin context carrying webServer.
 */
function makeRoutes(ctx) {
	return [
		{ kind: "exact", path: ROUTES.probe, handler: (req, res) => handleProbe(ctx, req, res) },
		{ kind: "exact", path: ROUTES.health, handler: (req, res) => handleHealth(ctx, req, res) },
	];
}

/**
 * Mount the probe routes.
 * @param ctx - host plugin context carrying webServer.
 * @param config - resolved plugin config.
 */
export function apply(ctx, config) {
	if (config?.enabled === false) return;
	ctx.effect(() => {
		const disposers = makeRoutes(ctx).map((route) => ctx.webServer.register(route));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "api-probe: routes");
}