import { MediaError } from "./config.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { get } from "node:https";

// src/media/download.ts
const isPublicAddress = (address) => {
	if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/iu.test(address) && !/^2001:(?:0:|db8:)/iu.test(address) && !/^2002:/iu.test(address);
	if (isIP(address) !== 4) return false;
	const [a, b] = address.split(".").map(Number);
	return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19));
};
const attachmentUrl = (source, allowedHosts) => {
	let url;
	try {
		url = new URL(source);
	} catch {
		throw new MediaError("附件没有可用的 HTTPS 地址。");
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") throw new MediaError("附件地址必须使用 HTTPS 默认端口，且不能包含用户名或密码。");
	if (allowedHosts.length > 0 && !allowedHosts.includes(url.hostname)) throw new MediaError("附件域名尚未允许，请由主人配置 media.allowedHosts。");
	return url;
};
const downloadAttachment = async (source, config, signal, headers = {}) => {
	const url = attachmentUrl(source, config.allowedHosts);
	const addresses = await new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) {
			abort();
			signal.removeEventListener("abort", abort);
			return;
		}
		lookup(url.hostname, { all: true }).then(resolve, () => reject(new MediaError("附件域名解析失败。"))).finally(() => signal.removeEventListener("abort", abort));
	});
	signal.throwIfAborted();
	if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) throw new MediaError("附件地址不是公开网络地址。");
	const pinned = addresses[0];
	return await new Promise((resolve, reject) => {
		get(url, {
			signal,
			headers,
			agent: false,
			lookup: (_hostname, options, callback) => {
				if (typeof options === "object" && options.all) callback(null, [pinned]);
				else callback(null, pinned.address, pinned.family);
			}
		}, (response) => {
			if (response.statusCode !== 200) {
				response.destroy();
				reject(new MediaError("附件下载失败或发生重定向。"));
				return;
			}
			if (Number(response.headers["content-length"]) > config.maxBytes) {
				response.destroy();
				reject(new MediaError("附件超过大小限制。"));
				return;
			}
			const chunks = [];
			let bytes = 0;
			response.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > config.maxBytes) response.destroy(new MediaError("附件超过大小限制。"));
				else chunks.push(chunk);
			});
			response.on("error", reject);
			response.on("end", () => resolve(Buffer.concat(chunks)));
		}).on("error", (error) => reject(signal.aborted ? signal.reason : error instanceof MediaError ? error : new MediaError("附件下载失败。")));
	});
};
const imageMime = (data) => {
	if (data.subarray(0, 8).equals(Buffer.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	]))) return "image/png";
	if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
	if (/^GIF8[79]a/u.test(data.subarray(0, 6).toString("ascii"))) return "image/gif";
	if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") return "image/webp";
};
const audioFormat = (data) => {
	if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WAVE") return {
		mime: "audio/wav",
		extension: "wav"
	};
	if (data.subarray(0, 3).toString() === "ID3" || data[0] === 255 && (data[1] & 224) === 224 && (data[1] & 6) !== 0) return {
		mime: "audio/mpeg",
		extension: "mp3"
	};
	if (data.subarray(0, 4).toString() === "OggS") return {
		mime: "audio/ogg",
		extension: "ogg"
	};
	if (data.subarray(4, 8).toString() === "ftyp") return {
		mime: "audio/mp4",
		extension: "m4a"
	};
	if (data.subarray(0, 4).equals(Buffer.from([
		26,
		69,
		223,
		163
	]))) return {
		mime: "audio/webm",
		extension: "webm"
	};
	if (data.subarray(0, 4).toString() === "fLaC") return {
		mime: "audio/flac",
		extension: "flac"
	};
};

export { attachmentUrl, audioFormat, downloadAttachment, imageMime, isPublicAddress };