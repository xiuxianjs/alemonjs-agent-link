import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

// src/media/drawing.ts
const escape = (value) => value.replace(/[&<>"']/gu, (c) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	"\"": "&quot;",
	"'": "&apos;"
})[c]);
const color = (value, fallback) => {
	if (value === void 0) return fallback;
	if (typeof value !== "string" || !/^(?:#[a-f\d]{3}|#[a-f\d]{4}|#[a-f\d]{6}|#[a-f\d]{8}|[a-z]{1,20})$/iu.test(value)) throw new Error("绘图颜色格式无效");
	return value;
};
const number = (value, fallback = 0) => {
	if (value === void 0) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 4096) throw new Error("绘图坐标超出范围");
	return value;
};
const drawingSvg = (args) => {
	const width = number(args.width, 768), height = number(args.height, 768);
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 1024 || height > 1024) throw new Error("画布需要为 64–1024 像素");
	if (!Array.isArray(args.elements) || args.elements.length < 1 || args.elements.length > 256) throw new Error("绘图需要 1–256 个图形");
	const parts = args.elements.map((element) => {
		if (!element || typeof element !== "object" || Array.isArray(element)) throw new Error("绘图元素无效");
		const e = element;
		const style = `fill="${color(e.fill, "#000000")}" stroke="${color(e.stroke, "none")}" stroke-width="${Math.max(0, number(e.strokeWidth, 1))}" opacity="${Math.min(1, Math.max(0, number(e.opacity, 1)))}"`;
		const x = number(e.x), y = number(e.y);
		switch (e.type) {
			case "rect": return `<rect x="${x}" y="${y}" width="${Math.max(0, number(e.width))}" height="${Math.max(0, number(e.height))}" rx="${Math.max(0, number(e.radius))}" ${style}/>`;
			case "ellipse": return `<ellipse cx="${x}" cy="${y}" rx="${Math.max(0, number(e.rx))}" ry="${Math.max(0, number(e.ry))}" ${style}/>`;
			case "circle": return `<circle cx="${x}" cy="${y}" r="${Math.max(0, number(e.radius))}" ${style}/>`;
			case "line": return `<line x1="${x}" y1="${y}" x2="${number(e.x2)}" y2="${number(e.y2)}" ${style}/>`;
			case "path":
				if (typeof e.d !== "string" || e.d.length > 4e3 || !/^[MmLlHhVvCcSsQqTtAaZz\d+.,eE\s-]+$/u.test(e.d)) throw new Error("绘图路径无效");
				return `<path d="${escape(e.d)}" ${style}/>`;
			case "text":
				if (typeof e.text !== "string" || Array.from(e.text).length > 200) throw new Error("绘图文字过长");
				return `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${Math.min(96, Math.max(8, number(e.fontSize, 24)))}" ${style}>${escape(e.text)}</text>`;
			default: throw new Error("不支持的绘图元素");
		}
	});
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${color(args.background, "#ffffff")}"/>${parts.join("")}</svg>`;
	if (Buffer.byteLength(svg) > 65536) throw new Error("绘图内容过长");
	return svg;
};
const renderDrawing = async (args, signal) => {
	signal.throwIfAborted();
	const svg = drawingSvg(args);
	const modulePath = createRequire(import.meta.url).resolve("@resvg/resvg-js");
	const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const {Resvg}=require(workerData.modulePath); parentPort.postMessage(new Resvg(workerData.svg,{font:{loadSystemFonts:true}}).render().asPng());`, {
		eval: true,
		execArgv: [],
		workerData: {
			svg,
			modulePath
		}
	});
	let timer;
	let abort;
	try {
		return await new Promise((resolve, reject) => {
			abort = () => reject(signal.reason || /* @__PURE__ */ new Error("绘图已取消"));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			timer = setTimeout(() => reject(/* @__PURE__ */ new Error("绘图超时")), 1e4);
			worker.once("error", () => reject(/* @__PURE__ */ new Error("绘图渲染失败")));
			worker.once("exit", () => reject(/* @__PURE__ */ new Error("绘图进程退出")));
			worker.once("message", (data) => {
				const png = Buffer.from(data);
				if (png.length > 5242880 || !png.subarray(0, 8).equals(Buffer.from([
					137,
					80,
					78,
					71,
					13,
					10,
					26,
					10
				]))) reject(/* @__PURE__ */ new Error("绘图结果无效"));
				else resolve(png);
			});
		});
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		await worker.terminate();
	}
};
const drawingTool = (deliver) => ({
	name: "draw_image",
	description: "按用户要求绘制插画、图标、流程示意图或海报并生成本轮待发送的 PNG。你用图形元素构图，按数组顺序叠放；文字坐标为基线，圆/椭圆坐标为中心。不是照片级扩散生图，不支持参考图精确编辑。无需文件或终端权限。每回合最多发送一张，返回 created 表示图片已绘制，最终回复阶段才发送，不要提前声称已交付。",
	parameters: {
		type: "object",
		required: ["elements"],
		additionalProperties: false,
		properties: {
			width: {
				type: "integer",
				minimum: 64,
				maximum: 1024
			},
			height: {
				type: "integer",
				minimum: 64,
				maximum: 1024
			},
			background: { type: "string" },
			elements: {
				type: "array",
				maxItems: 256,
				items: {
					type: "object",
					required: ["type"],
					additionalProperties: false,
					properties: {
						type: {
							type: "string",
							enum: [
								"rect",
								"circle",
								"ellipse",
								"line",
								"path",
								"text"
							]
						},
						x: { type: "number" },
						y: { type: "number" },
						x2: { type: "number" },
						y2: { type: "number" },
						width: { type: "number" },
						height: { type: "number" },
						radius: { type: "number" },
						rx: { type: "number" },
						ry: { type: "number" },
						fill: { type: "string" },
						stroke: { type: "string" },
						strokeWidth: { type: "number" },
						opacity: { type: "number" },
						fontSize: { type: "number" },
						text: {
							type: "string",
							maxLength: 200
						},
						d: {
							type: "string",
							maxLength: 4e3
						}
					}
				}
			}
		}
	},
	available: (context) => !context.autonomous,
	execute: async (args, context) => {
		const png = await renderDrawing(args, context.signal);
		context.signal.throwIfAborted();
		await deliver(png);
		return {
			ok: true,
			created: true,
			format: "png",
			delivery: "queued-for-this-reply"
		};
	}
});

export { drawingSvg, drawingTool, renderDrawing };