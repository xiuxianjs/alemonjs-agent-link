import { DSHError } from "./errors.js";

// src/dsh/provider-error.ts
const providerImageError = (status, detail) => {
	if ([400, 422].includes(status) && /image not recognized|replace the image|图片无法识别|圖片無法辨識|invalid image|invalid_image|failed to decode image|unsupported image format/iu.test(detail)) return new DSHError("media", "这张图我没认出来，换一张试试，或者用文字告诉我吧。");
};

export { providerImageError };