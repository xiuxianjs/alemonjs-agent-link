import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { arch, platform, release } from "node:os";

// src/credentials/account-session.ts
/** Experimental DSH browser grant. Tokens stay in memory; no SMS automation or persistence. */
const origin = "https://platform.deepseek.com";
const headers = {
	"content-type": "application/json",
	"x-client-platform": "web",
	"x-client-version": "0.0.4",
	"x-client-locale": "zh_CN",
	"x-client-bundle-id": "",
	"x-client-timezone-offset": "28800"
};
function validCallback(requestUrl, expectedState, method = "GET") {
	const url = new URL(requestUrl, "http://127.0.0.1");
	const state = url.searchParams.get("state") || "";
	return method === "GET" && url.pathname === "/oauth/callback" && url.searchParams.getAll("state").length === 1 && url.searchParams.getAll("code").length === 1 && Boolean(url.searchParams.get("code")) && Buffer.byteLength(state) === Buffer.byteLength(expectedState) && timingSafeEqual(Buffer.from(state), Buffer.from(expectedState));
}
async function startSession({ request = fetch, timeoutMs = 6e5 } = {}) {
	const controller = new AbortController();
	const verifier = randomBytes(32).toString("base64url");
	const state = randomBytes(32).toString("base64url");
	let authorizeId, token, consumed = false;
	let resolveCode;
	const code = new Promise((resolve) => {
		resolveCode = resolve;
	});
	const server = createServer((req, res) => {
		if (controller.signal.aborted || consumed) {
			res.writeHead(410).end();
			return;
		}
		if (!validCallback(req.url || "/", state, req.method)) {
			res.writeHead(400).end();
			return;
		}
		consumed = true;
		resolveCode(new URL(req.url, "http://127.0.0.1").searchParams.get("code"));
		res.writeHead(200, {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			"referrer-policy": "no-referrer"
		}).end("授权回调已收到，正在验证。请查看终端结果。");
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
	let timer = setTimeout(() => {
		controller.abort();
		resolveCode(null);
	}, timeoutMs);
	const call = async (path, body, grant, independent = false) => {
		const res = await request(origin + path, {
			method: body === void 0 ? "GET" : "POST",
			headers: {
				...headers,
				...grant ? { "x-dsh-auth-token": grant } : {}
			},
			body: body === void 0 ? void 0 : JSON.stringify(body),
			redirect: "error",
			signal: independent ? AbortSignal.timeout(15e3) : AbortSignal.any([controller.signal, AbortSignal.timeout(15e3)])
		});
		if (!res.ok || !res.body) {
			await res.body?.cancel();
			throw new Error(`platform-http-${res.status}`);
		}
		const reader = res.body.getReader();
		const chunks = [];
		let size = 0;
		try {
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.length;
				if (size > 65536) throw new Error("response-limit");
				chunks.push(part.value);
			}
			const value = JSON.parse(Buffer.concat(chunks).toString());
			if (value.code !== 0 || value.data?.biz_code !== 0) throw new Error("platform-response-rejected");
			return value.data.biz_data;
		} finally {
			await reader.cancel();
		}
	};
	const dispose = async () => {
		controller.abort();
		resolveCode(null);
		clearTimeout(timer);
		await new Promise((resolve) => server.close(() => resolve()));
		if (token) {
			const old = token;
			token = void 0;
			await call("/auth-api/v0/users/logout", {}, old, true);
		} else if (authorizeId) await call("/auth-api/v0/dsh/auth_cancel", {
			authorize_id: authorizeId,
			code_verifier: verifier
		}, void 0, true);
	};
	try {
		const initial = await call("/auth-api/v0/dsh/auth_init", {
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
			state,
			redirect_uri: redirectUri,
			locale: "zh_CN",
			login_source: "web"
		});
		authorizeId = initial.authorize_id;
		const url = new URL(initial.authorize_url);
		if (typeof authorizeId !== "string" || !authorizeId || url.origin !== origin || url.pathname !== "/dsh/authorize" || url.username || url.password || url.hash || !Number.isFinite(initial.expires_in) || initial.expires_in <= 0) throw new Error("invalid-authorization");
		clearTimeout(timer);
		timer = setTimeout(() => {
			controller.abort();
			resolveCode(null);
		}, Math.min(timeoutMs, initial.expires_in * 1e3));
		return {
			authorizeUrl: url.href,
			dispose,
			async verify({ model, onGrant } = {}) {
				const received = await code;
				if (!received || controller.signal.aborted) throw new Error("authorization-cancelled");
				const grant = await call("/auth-api/v0/dsh/auth_exchange", {
					code: received,
					code_verifier: verifier,
					redirect_uri: redirectUri,
					device_id: randomUUID(),
					device_model: `${platform()}-${arch()}`,
					os_version: `${platform()} ${release()}`
				});
				if (typeof grant.token !== "string" || !/^[\x21-\x7e]+$/.test(grant.token)) throw new Error("invalid-grant");
				token = grant.token;
				controller.signal.throwIfAborted();
				await call("/auth-api/v0/users/current", void 0, token);
				await call("/api/v0/users/get_user_summary", void 0, token);
				const report = {
					authorized: true,
					profileQuery: true,
					balanceQuery: true
				};
				if (model) {
					const response = await request("https://api.deepseek.com/chat/completions", {
						method: "POST",
						redirect: "error",
						signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6e4)]),
						headers: {
							"content-type": "application/json",
							"x-dsh-auth-token": token
						},
						body: JSON.stringify({
							model,
							messages: [{
								role: "user",
								content: "Reply OK."
							}],
							max_tokens: 16,
							stream: false
						})
					});
					report.inferenceHttp = response.status;
					const reader = response.body?.getReader();
					let size = 0;
					const chunks = [];
					try {
						if (!reader) throw new Error("missing-response");
						for (;;) {
							const part = await reader.read();
							if (part.done) break;
							size += part.value.length;
							if (size > 65536) throw new Error("response-limit");
							chunks.push(part.value);
						}
						const result = JSON.parse(Buffer.concat(chunks).toString());
						report.inference = response.ok && Array.isArray(result.choices) && result.choices.length > 0 && typeof result.choices[0]?.message?.content === "string";
					} finally {
						await reader?.cancel();
					}
				}
				if (onGrant) {
					await onGrant(token);
					token = void 0;
					authorizeId = void 0;
				}
				return report;
			}
		};
	} catch (error) {
		await dispose().catch(() => void 0);
		throw error;
	}
}

export { startSession, validCallback };