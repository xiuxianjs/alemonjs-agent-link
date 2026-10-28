import { imageMime } from "./download.js";

// src/media/image-info.ts
const jpegSize = (data) => {
	let offset = 2;
	while (offset + 4 <= data.length) {
		if (data[offset] !== 255) {
			offset++;
			continue;
		}
		const marker = data[offset + 1];
		if (marker === 216 || marker === 217) {
			offset += 2;
			continue;
		}
		if (marker === 218) break;
		const length = data.readUInt16BE(offset + 2);
		if (length < 2) break;
		if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
			if (offset + 9 > data.length) break;
			return {
				height: data.readUInt16BE(offset + 5),
				width: data.readUInt16BE(offset + 7)
			};
		}
		offset += 2 + length;
	}
};
const webpSize = (data) => {
	if (data.length < 30) return void 0;
	const chunk = data.subarray(12, 16).toString("ascii");
	if (chunk === "VP8X") return {
		width: data.readUIntLE(24, 3) + 1,
		height: data.readUIntLE(27, 3) + 1,
		animated: Boolean(data[20] & 2)
	};
	if (chunk === "VP8L" && data[20] === 47) {
		const bits = data.readUInt32LE(21);
		return {
			width: (bits & 16383) + 1,
			height: (bits >> 14 & 16383) + 1,
			animated: false
		};
	}
	if (chunk === "VP8 " && data[23] === 157 && data[24] === 1 && data[25] === 42) return {
		width: data.readUInt16LE(26) & 16383,
		height: data.readUInt16LE(28) & 16383,
		animated: false
	};
};
/**
* Read intrinsic dimensions without decoding pixels. Used to reject decompression bombs before
* handing an untrusted image to the SVG rasterizer.
*/
const imageInfo = (data) => {
	const mime = imageMime(data);
	if (!mime) return void 0;
	if (mime === "image/png") {
		if (data.length < 24 || data.subarray(12, 16).toString("ascii") !== "IHDR") return void 0;
		return {
			mime,
			width: data.readUInt32BE(16),
			height: data.readUInt32BE(20),
			animated: false
		};
	}
	if (mime === "image/jpeg") {
		const size = jpegSize(data);
		return size ? {
			mime,
			...size,
			animated: false
		} : void 0;
	}
	if (mime === "image/gif") {
		if (data.length < 10) return void 0;
		return {
			mime,
			width: data.readUInt16LE(6),
			height: data.readUInt16LE(8),
			animated: data.includes(Buffer.from("NETSCAPE2.0")) || data.includes(Buffer.from("ANIMEXTS1.0"))
		};
	}
	const size = webpSize(data);
	return size ? {
		mime,
		...size
	} : void 0;
};

export { imageInfo };