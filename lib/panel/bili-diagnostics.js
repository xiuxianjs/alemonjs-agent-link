import { checkFfmpeg, ffmpegAvailable } from "../bili/ffmpeg.js";
import { getMediaConfig } from "../media/config.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import { visionSource } from "../media/vision.js";
import "../bili/vision.js";
import { biliOptions } from "../bili/client.js";

// src/panel/bili-diagnostics.ts
const inspectBiliReadiness = async (config = getDSHConfig, media = getMediaConfig, ffmpeg = () => ffmpegAvailable(true)) => {
	const checks = [];
	let audioRead;
	try {
		const current = config();
		const settings = biliOptions(current.modules?.settings?.bili || {});
		audioRead = Boolean(settings.audioRead);
		const enabled = settings.enabled && !current.modules?.disabled?.includes("bili");
		checks.push({
			id: "module",
			label: "B站模块",
			state: enabled ? "ready" : "disabled",
			detail: enabled ? "模块已启用；不代表平台请求一定成功。" : "请启用 B站模块及其 enabled 设置。"
		});
		checks.push({
			id: "visual",
			label: "画面读取",
			state: settings.visualRead ? "ready" : "disabled",
			detail: settings.visualRead ? "已开启，最多三张静帧；需要视觉服务。单段视频解码依赖 ffmpeg；本机缺失时跳过视频下载，直接尝试B站低清预览故事板，不能保证可取得。" : "当前关闭；可设置 modules.settings.bili.visualRead 为 true。字幕和评论读取不依赖此开关。"
		});
		checks.push({
			id: "cookie",
			label: "B站登录资料",
			state: settings.cookie.trim() ? "ready" : "missing",
			detail: settings.cookie.trim() ? "已填写，未验证有效期或登录状态。" : "未填写 Cookie；部分公开视频可能仍可读取，需要登录的内容可能失败。"
		});
	} catch {
		checks.push({
			id: "module",
			label: "B站配置",
			state: "invalid",
			detail: "当前运行配置未通过解析，请检查 B站及基础配置；未执行平台请求。"
		});
	}
	try {
		const settings = media();
		const source = visionSource(settings, settings.vision ? void 0 : config());
		checks.push({
			id: "vision",
			label: "视觉服务",
			state: source ? "ready" : "missing",
			detail: source === "explicit" ? "独立 media.vision 配置可解析；未调用模型，不代表服务可用或识别准确。" : source === "model_pool" ? "模型池已配置视觉端点；未调用模型，不保证当前容量可用或识别准确。实际读取遵守模型池与会话预算。" : "请配置独立 media.vision，或在模型池启用声明 vision 能力的端点；普通聊天密钥不会自动替代视觉服务。"
		});
		const localAsr = settings.asr && [
			"localhost",
			"127.0.0.1",
			"[::1]"
		].includes(new URL(settings.asr.baseUrl).hostname);
		checks.push({
			id: "audio",
			label: "无字幕片段转写",
			state: audioRead === void 0 ? "invalid" : !audioRead ? "disabled" : !settings.asr ? "missing" : localAsr ? "ready" : "invalid",
			detail: audioRead === void 0 ? "B站配置无效，未检查转写开关。" : !audioRead ? "当前关闭；可设置 modules.settings.bili.audioRead 并配置本地 media.asr。" : !settings.asr ? "已开启但未配置本地 media.asr；不会上传音频。" : localAsr ? "本地ASR配置可解析；未连接服务或执行识别。仅在没有可用字幕时尝试最多60秒片段，仍需ffmpeg。" : "视频转写仅接收loopback本地ASR；当前服务不用于此路径，未上传音频。"
		});
	} catch {
		checks.push({
			id: "vision",
			label: "媒体配置",
			state: "invalid",
			detail: "媒体配置未通过解析，请检查 media 配置；不会回显凭据或服务地址。"
		});
		checks.push({
			id: "audio",
			label: "无字幕片段转写",
			state: "invalid",
			detail: "配置未通过解析，未连接ASR服务。"
		});
	}
	let installed = false;
	try {
		installed = await ffmpeg();
	} catch {}
	checks.push({
		id: "ffmpeg",
		label: "视频解码工具",
		state: installed ? "ready" : "missing",
		detail: installed ? "当前机器人进程可运行 ffmpeg；尚未验证实际视频解码。" : "当前进程无法确认 ffmpeg 可用。视频解码、硬字幕带及本地音频提取需要将其安装到机器人进程的 PATH；普通静帧可尝试低清预览故事板，字幕接口仍可使用。"
	});
	return {
		checkedAt: Date.now(),
		checks,
		scope: "local_only",
		notice: "仅检查本机依赖与当前配置，不访问 B站、不调用模型、不产生模型费用，也不修改配置。配置就绪不等于完成真实阅读验收。"
	};
};

export { checkFfmpeg, inspectBiliReadiness };