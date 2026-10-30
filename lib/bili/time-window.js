// src/bili/time-window.ts
/** Only unambiguous numeric requests; ordinary descriptions retain default sampling. */
const questionTimeWindow = (text) => {
	if (text.length > 4e3 || /不要|别看|不看|不是|不用看|无需|忽略|假如|假设|例如|比如|如果/u.test(text)) return;
	const matches = [...text.matchAll(/(最后|末尾|结尾|开头|最初|前)\s*(\d+(?:\.\d+)?)\s*秒|(?:第\s*)?(\d+(?:\.\d+)?)\s*秒?\s*(?:到|至|[-~～—])\s*(\d+(?:\.\d+)?)\s*秒/gu)];
	if (matches.length !== 1) return;
	const match = matches[0];
	const endIndex = match.index + match[0].length;
	if (/^\s*(?:到|至|[-~～—]|之前|之后|以前|以后|以外|前|后)/u.test(text.slice(endIndex))) return;
	if ([...text.matchAll(/\d+(?:\.\d+)?\s*秒/gu)].some((time) => time.index < match.index || time.index + time[0].length > endIndex)) return;
	if (match[1]) {
		const seconds = Number(match[2]);
		return seconds > 0 && seconds <= 86400 ? {
			edge: /最后|末尾|结尾/u.test(match[1]) ? "end" : "start",
			seconds
		} : void 0;
	}
	const start = Number(match[3]);
	const end = Number(match[4]);
	if (match.index > 0 && /[\d.\-−]/u.test(text[match.index - 1])) return;
	return start >= 0 && start < end && end <= 86400 ? {
		edge: "range",
		start,
		end
	} : void 0;
};
const windowSampleTimes = (duration, window) => {
	if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw new Error("缺少有效分P时长。");
	let start;
	let end;
	if (window.edge === "range") {
		start = window.start;
		end = window.end;
	} else {
		if (!["start", "end"].includes(window.edge) || !Number.isFinite(window.seconds) || window.seconds <= 0 || window.seconds > 86400) throw new Error("采样时间范围无效。");
		start = window.edge === "end" ? Math.max(0, duration - window.seconds) : 0;
		end = window.edge === "end" ? duration : Math.min(duration, window.seconds);
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end || end > duration) throw new Error("采样时间范围超出当前第1分P。");
	return {
		start,
		end,
		timestamps: [...new Set([
			.1,
			.5,
			.9
		].map((ratio) => start + (end - start) * ratio))].filter((time) => time < duration)
	};
};

export { questionTimeWindow, windowSampleTimes };