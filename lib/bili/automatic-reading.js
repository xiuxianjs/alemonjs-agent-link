import { visualCropRequest } from "./crop.js";
import { visualSampleRequest } from "./visual.js";
import { videoId } from "./client.js";

// src/bili/automatic-reading.ts
/** Per-turn attempts, including failures. A refinement spends the same budget as a new candidate. */
var AutomaticReadingAttempts = class {
	searched = false;
	attempts = 0;
	links = /* @__PURE__ */ new Set();
	pending = /* @__PURE__ */ new WeakSet();
	overviews = /* @__PURE__ */ new Map();
	claimSearch() {
		if (this.searched) return false;
		this.searched = true;
		return true;
	}
	snapshot(limit, allowRefinement) {
		const remainingAttempts = Math.max(0, (Number.isSafeInteger(limit) && limit >= 0 && limit <= 3 ? limit : 0) - this.attempts);
		return {
			attemptsUsed: this.attempts,
			remainingAttempts,
			refinableVideos: allowRefinement && remainingAttempts > 0 ? [...this.overviews].filter(([, entry]) => !entry.refined).map(([bvid]) => bvid) : []
		};
	}
	decide(request, limit, allowRefinement) {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3 || this.attempts >= limit) return { reason: "attempt_limit" };
		const parsed = videoId(request.link);
		const bvid = parsed && "bvid" in parsed ? parsed.bvid : void 0;
		const key = bvid || (parsed && "aid" in parsed ? `av${parsed.aid}` : parsed && "short" in parsed ? parsed.short : request.link.trim());
		const kind = request.visualAt === void 0 && request.visualCrop === void 0 && (request.visualFocus === void 0 || request.visualFocus === "frames") ? "overview" : "initial";
		if (!this.links.has(key)) return {
			key,
			kind
		};
		if (!allowRefinement) return { reason: "refinement_disabled" };
		const overview = bvid && this.overviews.get(bvid);
		if (!overview) return { reason: "overview_required" };
		if (overview.refined) return { reason: "refinement_already_attempted" };
		try {
			const at = visualSampleRequest(request.visualAt);
			const crop = visualCropRequest(request.visualCrop);
			const focus = request.visualFocus ?? "frames";
			if (!at) return { reason: "explicit_times_required" };
			if (!["frames", "subtitles"].includes(String(focus)) || crop && focus !== "frames") return { reason: "invalid_refinement_request" };
			if (!crop && focus === "frames" && at.every((time) => overview.times.some((previous) => Math.abs(previous - time) <= .001))) return { reason: "already_sampled_points" };
		} catch {
			return { reason: "invalid_refinement_request" };
		}
		return {
			key,
			kind: "refinement",
			overview
		};
	}
	rejectionReason(request, limit, allowRefinement) {
		return this.decide(request, limit, allowRefinement).reason;
	}
	claim(request, limit, allowRefinement) {
		const decision = this.decide(request, limit, allowRefinement);
		if (decision.reason) return;
		if (decision.overview) decision.overview.refined = true;
		this.attempts++;
		this.links.add(decision.key);
		const ticket = Object.freeze({
			key: decision.key,
			kind: decision.kind
		});
		this.pending.add(ticket);
		return ticket;
	}
	complete(ticket, result) {
		if (!this.pending.delete(ticket) || !result) return;
		const parsed = videoId(result.video.bvid);
		if (!parsed || !("bvid" in parsed) || parsed.bvid !== result.video.bvid) return;
		const bvid = parsed.bvid;
		this.links.add(bvid);
		if (ticket.kind !== "overview" || !result.evidence.visualObserved || ["crop", "bottom_band"].includes(result.visual.region) || this.overviews.has(bvid)) return;
		const times = result.visual.timestamps;
		if (!times.length || times.length > 9 || times.some((time) => !Number.isFinite(time) || time < 0)) return;
		this.overviews.set(bvid, {
			times: times.slice(),
			refined: false
		});
	}
};

export { AutomaticReadingAttempts };