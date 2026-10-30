// src/bili/crop.ts
/** Relative coordinates of the source frame, before resizing. */
const visualCropRequest = (value) => {
	if (value === void 0) return void 0;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("画面裁剪范围无效。");
	const crop = value;
	const keys = [
		"x",
		"y",
		"width",
		"height"
	];
	if (Object.keys(crop).length !== 4 || Object.keys(crop).some((key) => !keys.includes(key)) || keys.some((key) => typeof crop[key] !== "number" || !Number.isFinite(crop[key]))) throw new Error("画面裁剪需要x、y、width、height四个有限数值。");
	if (crop.x < 0 || crop.y < 0 || crop.width < .01 || crop.height < .01 || crop.x + crop.width > 1 || crop.y + crop.height > 1) throw new Error("画面裁剪坐标须在0–1内，宽高至少0.01，且不能越出画面。");
	return {
		x: crop.x,
		y: crop.y,
		width: crop.width,
		height: crop.height
	};
};
const cropPixels = (width, height, crop) => {
	const left = Math.floor(width * crop.x), top = Math.floor(height * crop.y);
	return {
		left,
		top,
		width: Math.max(1, Math.min(width, Math.ceil(width * (crop.x + crop.width))) - left),
		height: Math.max(1, Math.min(height, Math.ceil(height * (crop.y + crop.height))) - top)
	};
};

export { cropPixels, visualCropRequest };