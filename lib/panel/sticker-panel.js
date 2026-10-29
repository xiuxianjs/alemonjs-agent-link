import { MediaError, getMediaConfig } from "../media/config.js";
import { imageMime } from "../media/download.js";
import { collectSticker, ensureStickerRoot, listAssets, listStickers, loadSticker, renameSticker, setStickerEmoji, updateSticker } from "../media/stickers.js";
import { addFavoriteDirect, deleteFavoriteDirect, fetchFavoriteUrlsDirect, renameFavoriteDirect } from "../media/onebot-direct.js";
import { getActiveOneBotConnection } from "../onebot/index.js";
import { importStickerUrls } from "../media/sticker-import.js";
import { logger } from "alemonjs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

// src/panel/sticker-panel.ts
const MAX_BODY = 8388608;
const MAX_IMAGE = 5242880;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/u;
const MIME_EXTENSION = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif"
};
const stickerPanelConfig = (config) => {
	const raw = config.modules?.settings?.stickers?.panel;
	const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const enabled = input.enabled ?? true;
	const host = input.host ?? "127.0.0.1";
	const port = input.port ?? 8787;
	const token = input.token;
	if (typeof enabled !== "boolean") throw new Error("表情面板 enabled 必须是布尔值。");
	if (!enabled) return void 0;
	if (host !== "127.0.0.1" && host !== "::1") throw new Error("表情面板只能绑定回环地址。");
	if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("表情面板端口无效。");
	if (token !== void 0 && (typeof token !== "string" || token.length > 0 && (token.length < 16 || token.length > 128 || /\s/u.test(token)))) throw new Error("表情面板 token 需要为 16–128 位不含空白的字符串。");
	return {
		enabled,
		host,
		port: Number(port),
		token: typeof token === "string" ? token : ""
	};
};
const send = (res, status, body, type = "text/plain; charset=utf-8", extra = {}) => {
	res.writeHead(status, {
		"Content-Type": type,
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"Referrer-Policy": "no-referrer",
		...extra
	});
	res.end(body);
};
const json = (res, status, value) => send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
const readBody = async (req) => {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += part.length;
		if (bytes > MAX_BODY) throw new MediaError("请求体超过限制。");
		chunks.push(part);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text.trim()) return {};
	try {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
		return parsed;
	} catch {
		throw new MediaError("请求体不是有效 JSON 对象。");
	}
};
const authorized = (req, url, token) => {
	const header = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
	const supplied = url.searchParams.get("token") || header;
	if (typeof supplied !== "string" || supplied.length !== token.length) return false;
	return timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
};
const publicItem = (item, token) => ({
	id: item.id,
	name: item.name ?? "",
	tags: item.tags,
	kind: item.kind ?? "sticker",
	category: item.category ?? "",
	context: item.context ?? "",
	from: item.from ?? "legacy",
	uses: item.uses ?? 0,
	lastUsed: item.lastUsed ?? null,
	width: item.width ?? null,
	height: item.height ?? null,
	emojiId: Boolean(item.emojiId),
	image: `/api/stickers/${encodeURIComponent(item.id)}/image?token=${encodeURIComponent(token)}`
});
const page = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentLink 表情库</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0f1115;color:#e8eaf0;font:14px/1.5 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
header{padding:18px 22px;border-bottom:1px solid #262b36;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0;flex:1}.muted{color:#8b93a7}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button,input{background:#171b23;border:1px solid #2c3342;color:#e8eaf0;border-radius:8px;padding:8px 10px;font:inherit}
button{cursor:pointer}button:hover{background:#222938}button.danger{border-color:#5b2a30;color:#ffb4b4}
main{padding:18px 22px;display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}
.card{background:#151922;border:1px solid #262b36;border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:8px}
.thumb{width:100%;aspect-ratio:1;object-fit:contain;background:#0b0d11;border-radius:10px}
.card input{width:100%;box-sizing:border-box}.tags{color:#8b93a7;font-size:12px;word-break:break-all}
#status{white-space:pre-wrap;color:#ffcf9e}.toolbar{padding:0 22px 8px}
</style></head><body>
<header><h1>AgentLink 表情库</h1><div class="row"><input id="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple><input id="uploadName" placeholder="名称（可选）" maxlength="24"><input id="uploadTags" placeholder="标签，用逗号分隔" maxlength="100"><select id="uploadKind"><option value="sticker">表情</option><option value="avatar">头像</option></select><button id="upload">上传</button><button id="importFav">从 QQ 导入</button><button id="syncFav">同步到 QQ</button><button id="refresh">刷新</button></div></header>
<div class="toolbar"><span class="muted">token 从 URL 读取；面板只监听回环地址，不提供跨域访问。</span></div>
<div id="status" class="toolbar"></div><main id="list"></main>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const status = document.querySelector('#status');
const list = document.querySelector('#list');
const say = (text) => { status.textContent = text; };
const api = async (path, options = {}) => {
  const response = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token), {
    ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  let value = null; try { value = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error((value && value.message) || text || ('HTTP ' + response.status));
  return value;
};
const button = (label, className, onClick) => { const b = document.createElement('button'); b.textContent = label; if (className) b.className = className; b.onclick = onClick; return b; };
const card = (item) => {
  const box = document.createElement('div'); box.className = 'card';
  const img = document.createElement('img'); img.className = 'thumb'; img.loading = 'lazy'; img.alt = item.name || item.id; img.src = item.image; box.append(img);
  const name = document.createElement('input'); name.value = item.name; name.maxLength = 24; name.placeholder = '名称'; box.append(name);
  const tags = document.createElement('input'); tags.value = item.tags.join('，'); tags.placeholder = '标签，用逗号分隔'; box.append(tags);
  const meta = document.createElement('div'); meta.className = 'tags'; meta.textContent = item.kind + ' · ' + (item.category || '未分类') + ' · ' + item.id + ' · 用过 ' + item.uses + (item.emojiId ? ' · QQ 已收藏' : '') + (item.context ? '\n' + item.context : ''); meta.style.whiteSpace = 'pre-wrap'; box.append(meta);
  const row = document.createElement('div'); row.className = 'row';
  row.append(button('保存', '', async () => {
    try {
      say('保存中…');
      await api('/api/stickers/' + encodeURIComponent(item.id), { method: 'PATCH', body: JSON.stringify({ name: name.value.trim(), tags: tags.value.split(/[，,]/).map(t => t.trim()).filter(Boolean) }) });
      say('已保存'); await refresh();
    } catch (error) { say('保存失败：' + error.message); }
  }));
  row.append(button('删除', 'danger', async () => {
    if (!confirm('从素材清单移除；如果已写入 QQ 收藏，也会尝试删除。原图片文件保留。确定？')) return;
    try { say('删除中…'); await api('/api/stickers/' + encodeURIComponent(item.id), { method: 'DELETE' }); say('已移除'); await refresh(); }
    catch (error) { say('删除失败：' + error.message); }
  }));
  box.append(row); return box;
};
const refresh = async () => {
  try {
    const result = await api('/api/stickers'); list.replaceChildren(...result.items.map(card));
  } catch (error) { say('读取失败：' + error.message); }
};
document.querySelector('#refresh').onclick = refresh;
const upload = async () => {
  const files = [...document.querySelector('#file').files];
  if (!files.length) return say('先选择图片。');
  const name = document.querySelector('#uploadName').value.trim();
  const kind = document.querySelector('#uploadKind').value === 'avatar' ? 'avatar' : 'sticker';
  const tags = document.querySelector('#uploadTags').value.split(/[，,]/).map(t => t.trim()).filter(Boolean);
  for (const file of files) {
    try {
      say('上传 ' + file.name + '…');
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
      await api('/api/stickers', { method: 'POST', body: JSON.stringify({ data: String(data).replace(/^data:[^,]+,/, ''), name, tags, kind }) });
    } catch (error) { say('上传失败：' + error.message); return; }
  }
  say('上传完成'); await refresh();
};
document.querySelector('#upload').onclick = upload;
const importFav = async () => {
  try {
    say('正在读取 QQ 收藏…');
    const result = await api('/api/import', { method: 'POST', body: '{}' });
    say('导入完成：新增 ' + result.added + '，已有 ' + result.existing + '，失败 ' + result.failed);
    await refresh();
  } catch (error) { say('导入失败：' + error.message); }
};
const syncFav = async () => {
  try {
    say('正在同步到 QQ 收藏…');
    const result = await api('/api/sync', { method: 'POST', body: '{}' });
    say('同步完成：新增 ' + result.added + '，更新名称 ' + result.renamed + '，失败 ' + result.failed);
    await refresh();
  } catch (error) { say('同步失败：' + error.message); }
};
document.querySelector('#importFav').onclick = importFav;
document.querySelector('#syncFav').onclick = syncFav;
refresh();
<\/script></body></html>`;
const importFavorites = async (res, media) => {
	const connection = getActiveOneBotConnection();
	if (!connection) {
		json(res, 503, {
			ok: false,
			message: "OneBot 尚未连接，无法读取 QQ 收藏。"
		});
		return;
	}
	const urls = await fetchFavoriteUrlsDirect(connection, 50);
	if (urls === void 0) {
		json(res, 502, {
			ok: false,
			message: "读取 QQ 收藏失败，网关可能不支持 fetch_custom_face。"
		});
		return;
	}
	try {
		const imported = await importStickerUrls(media, urls, AbortSignal.timeout(12e4));
		json(res, 200, {
			ok: true,
			...imported
		});
	} catch {
		json(res, 504, {
			ok: false,
			message: "导入超时或中断，已成功的部分仍保留。"
		});
	}
};
const syncFavorites = async (res, media) => {
	const connection = getActiveOneBotConnection();
	if (!connection) {
		json(res, 503, {
			ok: false,
			message: "OneBot 尚未连接，无法写入 QQ 收藏。"
		});
		return;
	}
	const signal = AbortSignal.timeout(12e4);
	const items = (await listStickers(media)).filter((item) => item.from !== "import").slice(0, 20);
	let added = 0;
	let renamed = 0;
	let failed = 0;
	for (const item of items) {
		if (signal.aborted) break;
		const name = (item.name || item.tags[0] || "").trim().slice(0, 20);
		if (item.emojiId) {
			if (!name) continue;
			if (await renameFavoriteDirect(connection, item.emojiId, name)) renamed++;
			else failed++;
			continue;
		}
		try {
			const emojiId = await addFavoriteDirect(connection, await loadSticker(item, media), name || void 0);
			if (!emojiId) {
				failed++;
				continue;
			}
			await setStickerEmoji(media, item.id, emojiId, signal);
			added++;
		} catch {
			failed++;
		}
	}
	json(res, 200, {
		ok: true,
		added,
		renamed,
		failed,
		total: items.length
	});
};
const handle = async (req, res, config, panel, media) => {
	const url = new URL(req.url || "/", `http://${panel.host === "::1" ? `[${panel.host}]` : panel.host}`);
	if (!authorized(req, url, panel.token)) {
		json(res, 401, {
			ok: false,
			message: "未授权：token 无效。"
		});
		return;
	}
	if (!media.stickerRoot) {
		json(res, 503, {
			ok: false,
			message: "尚未配置表情素材目录。"
		});
		return;
	}
	if (req.method === "GET" && url.pathname === "/") {
		send(res, 200, page(), "text/html; charset=utf-8", { "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
		return;
	}
	if (req.method === "POST" && url.pathname === "/api/import") {
		await importFavorites(res, media);
		return;
	}
	if (req.method === "POST" && url.pathname === "/api/sync") {
		await syncFavorites(res, media);
		return;
	}
	const match = /^\/api\/stickers(?:\/([a-zA-Z0-9_-]{1,40})(\/image)?)?$/u.exec(url.pathname);
	if (!match) {
		json(res, 404, {
			ok: false,
			message: "接口不存在。"
		});
		return;
	}
	const id = match[1];
	const image = Boolean(match[2]);
	const items = await listAssets(media);
	if (!id) {
		if (req.method !== "GET") {
			json(res, 405, {
				ok: false,
				message: "方法不允许。"
			});
			return;
		}
		if (req.method === "GET" && !image) {
			json(res, 200, {
				ok: true,
				items: items.map((item) => publicItem(item, panel.token))
			});
			return;
		}
	}
	if (!ID_PATTERN.test(id)) {
		json(res, 404, {
			ok: false,
			message: "表情不存在。"
		});
		return;
	}
	const item = items.find((value) => value.id === id);
	if (!item) {
		json(res, 404, {
			ok: false,
			message: "表情不存在。"
		});
		return;
	}
	if (image) {
		if (req.method !== "GET") {
			json(res, 405, {
				ok: false,
				message: "方法不允许。"
			});
			return;
		}
		const data = await loadSticker(item, media);
		const mime = imageMime(data);
		if (!mime || !MIME_EXTENSION[mime]) {
			json(res, 415, {
				ok: false,
				message: "表情文件格式不支持。"
			});
			return;
		}
		send(res, 200, data, mime, { "Content-Disposition": `inline; filename="sticker.${MIME_EXTENSION[mime]}"` });
		return;
	}
	if (req.method === "PATCH") {
		const body = await readBody(req);
		const name = typeof body.name === "string" ? body.name.trim() : void 0;
		if (name !== void 0) {
			if (!name || Array.from(name).length > 24) throw new MediaError("名称需要 1–24 个字符。");
			await renameSticker(media, id, name, AbortSignal.timeout(1e4));
		}
		if (body.tags !== void 0) {
			if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string")) throw new MediaError("标签格式无效。");
			await updateSticker(media, id, body.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 10), AbortSignal.timeout(1e4));
		}
		const updated = (await listStickers(media)).find((value) => value.id === id);
		json(res, 200, {
			ok: true,
			item: updated ? publicItem(updated, panel.token) : null
		});
		return;
	}
	if (req.method === "DELETE") {
		const connection = getActiveOneBotConnection();
		const qqDeleted = item.emojiId && connection ? await deleteFavoriteDirect(connection, item.emojiId) : false;
		const removed = await updateSticker(media, id, null, AbortSignal.timeout(1e4));
		json(res, removed ? 200 : 404, {
			ok: removed,
			qqDeleted,
			message: removed ? `已从素材清单移除，原文件保留。${item.emojiId ? qqDeleted ? "QQ 收藏已删除。" : "QQ 收藏删除未确认。" : ""}` : "表情不存在。"
		});
		return;
	}
	json(res, 405, {
		ok: false,
		message: "方法不允许。"
	});
};
const handleUpload = async (req, res, panel, media) => {
	const body = await readBody(req);
	const data = typeof body.data === "string" ? body.data : "";
	const name = typeof body.name === "string" ? body.name.trim().slice(0, 24) : "";
	const tags = Array.isArray(body.tags) ? body.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 10) : [];
	const kind = body.kind === "avatar" ? "avatar" : "sticker";
	if (!data || data.length > Math.ceil(MAX_IMAGE * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) throw new MediaError("上传图片编码无效或过大。");
	const image = Buffer.from(data, "base64");
	if (!image.length || image.length > MAX_IMAGE || !imageMime(image)) throw new MediaError("上传内容不是受支持的图片。");
	const result = await collectSticker(media, image, tags.length ? tags : [kind === "avatar" ? "头像" : "面板"], AbortSignal.timeout(15e3), {
		from: "manual",
		kind,
		category: kind === "avatar" ? "头像" : "未分类",
		...name ? { name } : {}
	});
	json(res, 200, {
		ok: true,
		item: publicItem(result.item, panel.token),
		existing: result.existing
	});
};
const startStickerPanel = async (config, portOverride) => {
	const panel = stickerPanelConfig(config);
	if (!panel) return void 0;
	const media = getMediaConfig();
	if (!media.stickerRoot) {
		logger.warn("Sticker panel is enabled but media.stickerRoot is not configured");
		return;
	}
	await ensureStickerRoot(media);
	let token = panel.token;
	const tokenFile = join(dirname(config.workspaceRoot), "sticker-panel-token.txt");
	if (!token) {
		try {
			const stored = (await readFile(tokenFile, "utf8")).trim();
			if (stored.length >= 16 && stored.length <= 128 && !/\s/u.test(stored)) token = stored;
		} catch {}
		if (!token) {
			token = randomBytes(32).toString("hex");
			await mkdir(dirname(tokenFile), {
				recursive: true,
				mode: 448
			});
			await writeFile(tokenFile, `${token}\n`, { mode: 384 });
			await chmod(tokenFile, 384);
			logger.info({ path: tokenFile }, "Sticker panel token written");
		}
	}
	const active = {
		...panel,
		token
	};
	const server = createServer((req, res) => {
		(async () => {
			const url = new URL(req.url || "/", `http://${active.host === "::1" ? `[${active.host}]` : active.host}`);
			if (!authorized(req, url, active.token)) {
				json(res, 401, {
					ok: false,
					message: "未授权：token 无效。"
				});
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/stickers") {
				await handleUpload(req, res, active, media);
				return;
			}
			await handle(req, res, config, active, media);
		})().catch((error) => {
			if (res.headersSent) return;
			logger.warn({ err: error }, "Sticker panel request failed");
			json(res, error instanceof MediaError ? 400 : 500, {
				ok: false,
				message: error instanceof MediaError ? error.message : "面板请求失败。"
			});
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(portOverride ?? panel.port, panel.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : panel.port;
	logger.info({
		port,
		host: active.host,
		tokenFile
	}, "Sticker panel ready on loopback");
	return {
		server,
		port,
		token: active.token,
		close: () => new Promise((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		})
	};
};

export { startStickerPanel, stickerPanelConfig };