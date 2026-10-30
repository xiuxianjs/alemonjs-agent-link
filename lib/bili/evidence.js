import { visualCropRequest } from "./crop.js";

// src/bili/evidence.ts
/** Describes received sources only, without rating the content or trusting comments as facts. */
const biliEvidence = (subtitles, comments, visual, audio) => {
	const hasSubtitleText = subtitles.status === "available" && Boolean(subtitles.text.trim());
	let crop;
	try {
		crop = visualCropRequest(visual?.crop);
	} catch {}
	const visualObserved = visual?.status === "available" && Boolean(visual.description.trim()) && (visual.region !== "crop" || Boolean(crop)) && (crop === void 0 || visual.region === "crop") && visual.timestamps.length > 0 && visual.timestamps.length <= (visual.region === "bottom_band" ? 12 : visual.region === "frame_grid" ? 9 : 3) && visual.timestamps.every((time) => Number.isFinite(time) && time >= 0);
	const audioTranscribed = audio?.status === "available" && Boolean(audio.text.trim()) && typeof audio.startSeconds === "number" && typeof audio.endSeconds === "number" && Number.isFinite(audio.startSeconds) && Number.isFinite(audio.endSeconds) && audio.startSeconds >= 0 && audio.endSeconds <= 86400 && audio.endSeconds > audio.startSeconds && audio.endSeconds - audio.startSeconds <= 60;
	const basis = hasSubtitleText ? subtitles.truncated ? "subtitle_excerpt" : "subtitles" : audioTranscribed ? "audio_excerpt" : visualObserved ? "sampled_frames" : "metadata";
	const hasAudienceComments = comments.status === "available" && comments.items.some((item) => Boolean(item.text.trim()));
	return {
		basis,
		hasSubtitleText,
		hasAudienceComments,
		audienceCommentScope: comments.status !== "available" ? "unavailable" : hasAudienceComments ? "returned_subset" : "empty_response",
		visualObserved,
		sampledTimestamps: visualObserved ? visual.timestamps.slice() : [],
		...visualObserved && visual.region ? { visualRegion: visual.region } : {},
		...visualObserved && crop ? { visualCrop: crop } : {},
		...visualObserved && visual.source === "storyboard" ? { visualSource: "storyboard" } : {},
		audioObserved: false,
		audioTranscribed,
		...audioTranscribed ? { transcribedRange: [audio.startSeconds, audio.endSeconds] } : {},
		limitation: "评论仅指本次接口返回的有限文字；empty_response或unavailable不证明原视频零评论、没人留言或无人感兴趣。" + (audioTranscribed ? "仅取得transcribedRange范围的本地ASR文字，可能误识别或截断，不代表听过声音、理解语气或取得全片转写。" : "") + (visualObserved ? (visual.source === "storyboard" ? "来自B站第1分P的低清预览故事板；时间为预览索引近似位置，不能当作原视频精确帧或字幕原文。" : "") + (visual.region === "bottom_band" ? "仅提供画面底部25%的字幕带采样，不含完整画面；裁剪处可能没有字幕，也可能漏字或误读，不能拼成全片台词或音频转写。" : visual.region === "crop" ? "仅提供visualCrop指定的局部，边界可能有像素舍入；没有观察框外画面，不能据此推断整个界面或其他设置。" : "") + "视觉模型只描述了 sampledTimestamps 所列位置的采样静帧，描述可能出错；不能推断帧间过程、未采样情节、音频或全片质量。字幕若截断也只能讨论返回部分；评论仅为观众观点。" : hasSubtitleText ? subtitles.truncated ? "只有部分字幕可作内容依据，不可据此总结未返回的片段或声称理解全片；字幕本身也可能不准确。" : "可依据返回字幕讨论台词内容，不代表看过画面、听过音频或理解全片；字幕本身也可能不准确。" : audioTranscribed ? "除此之外只有标题简介等资料，不能补写未转写片段、画面、声音特征或内容质量。评论仅为观众观点。" : "只有标题简介等元数据，不能声称了解视频情节或质量；可以说主题引起兴趣，或跳过分享。评论仅为观众观点，不能补成视频事实。")
	};
};

export { biliEvidence };