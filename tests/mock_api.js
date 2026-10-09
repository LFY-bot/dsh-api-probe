/**
 * Mock OpenAI-compatible API used by the dsh-api-probe test suite.
 *
 * Model name selects the behaviour, so one server covers every failure mode
 * the panel has to explain:
 *   fast-model      TTFT 40ms,  6ms/token   — the good case
 *   slow-model      TTFT 1300ms, 90ms/token — usable but sluggish
 *   flaky-model     every 3rd request 500    — unstable line
 *   ratelimit       always 429              — valid key, no balance
 *   empty-model     200 with no content      — silently blocked
 *   text-embedding-3-small                   — must never be auto-picked
 *   gpt-4o-mini                               — must be auto-picked
 */

import http from "node:http";

export const KEY = "test-key-123456";

let flakyCounter = 0;

function sse(res, chunks) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
	});
	for (const piece of chunks) res.write("data: " + piece + "\n\n");
	res.write("data: [DONE]\n\n");
	res.end();
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatBody(model, stream) {
	if (model === "ratelimit") {
		return { status: 429, json: { error: { message: "insufficient balance" } } };
	}
	if (model === "empty-model") {
		return { status: 200, json: { choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }] } };
	}
	return { status: 200 };
}

export function startMockApi(port = 0) {
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://localhost");

		if (url.pathname === "/v1/models") {
			const auth = req.headers.authorization || "";
			if (auth !== `Bearer ${KEY}`) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "invalid api key" } }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					object: "list",
					data: [
						{ id: "text-embedding-3-small", object: "model" },
						{ id: "gpt-4o-mini", object: "model" },
						{ id: "some-random-model", object: "model" },
					],
				}),
			);
			return;
		}

		if (url.pathname === "/v1/chat/completions") {
			const auth = req.headers.authorization || "";
			if (auth !== `Bearer ${KEY}`) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "invalid api key" } }));
				return;
			}
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			let body = {};
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				body = {};
			}
			const model = body.model;

			if (model === "flaky-model") {
				flakyCounter += 1;
				if (flakyCounter % 3 === 0) {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
					return;
				}
			}

			const preset = chatBody(model, body.stream);
			if (preset.status !== 200) {
				res.writeHead(preset.status, { "content-type": "application/json" });
				res.end(JSON.stringify(preset.json));
				return;
			}

			if (model === "empty-model") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(preset.json));
				return;
			}

			const isSlow = model === "slow-model";
			const ttft = isSlow ? 1300 : 40;
			const perToken = isSlow ? 90 : 6;
			const text = "我是一个用于测速的假模型。";

			await sleep(ttft);
			if (body.stream === false) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 14, total_tokens: 24 },
					}),
				);
				return;
			}

			res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
			res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] }) + "\n\n");
			for (const char of text) {
				await sleep(perToken);
				res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: char } }] }) + "\n\n");
			}
			res.write(
				"data: " +
					JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 14 } }) +
					"\n\n",
			);
			res.write("data: [DONE]\n\n");
			res.end();
			return;
		}

		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "not found" } }));
	});

	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => {
			const actual = server.address().port;
			resolve({
				server,
				port: actual,
				base: `http://127.0.0.1:${actual}/v1`,
				close: () => new Promise((done) => server.close(done)),
			});
		});
	});
}