import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

// src/companion/interaction.ts
const hash = (value) => createHash("sha256").update(value).digest("hex");
const key = (scope) => hash(JSON.stringify([
	scope.platform,
	scope.botId || "",
	scope.channelId,
	scope.userId
]));
const HOUR = 36e5;
const fresh = () => ({
	muted: false,
	expires: 0,
	lastCare: 0,
	lastInput: "",
	restingUntil: 0
});
const plainInput = (input) => input.trim().replace(/^肥鱼[，,\s]*/u, "").replace(/[。！!呀啊啦～~\s]+$/u, "");
const untrustedScene = (text) => /[“”「」"\n]|转发|他说|她说|朋友说|如果|假如|例如|比如|翻译|什么意思|怎么说|怎么写/u.test(text);
const interactionScene = (input) => {
	const text = plainInput(input);
	if (!text || text.length > 180 || untrustedScene(text)) return "none";
	if (/^(?:结束角色扮演|退出角色扮演|停止角色扮演|不演了|先不演了|出戏了|回到现实)$/u.test(text)) return "end";
	if (/^(?:我们来|来|陪我)(?:玩)?角色扮演(?:[，,：:].{1,100})?$|^(?:你扮演|请扮演|陪我演).{1,100}$/u.test(text)) return "start";
	return "none";
};
const interactionSignal = (input) => {
	const text = plainInput(input);
	if (!text || text.length > 180 || untrustedScene(text) || /扮演/u.test(text)) return "none";
	if (/^(?:别催(?:我)?|不要催(?:我)?|别提醒(?:我)?|不要提醒(?:我)?|不用提醒(?:我)?|不可以提醒我|不可以催我|不许催我)(?:休息|睡觉|喝水)?(?:了)?$/u.test(text)) return "mute";
	if (/^(?:可以提醒我|继续提醒我|可以催我|恢复提醒)(?:了)?$/u.test(text)) return "resume";
	if (/^(?:我)?(?:去睡了|先睡了|睡觉去了|准备睡了|要睡了|先休息|晚安)$/u.test(text)) return "sleep";
	if (/^(?:我)?(?:喝过了|喝了水|已经喝了(?:水)?|不渴(?:了)?)$/u.test(text)) return "water-resolved";
	if (/^(?:我)?(?:不困(?:了)?|不累(?:了)?|休息过了|睡醒了|醒了|起床了|不睡了|睡不着|回来继续聊)$/u.test(text)) return "awake";
	if (/^(?:我)?(?:今天)?(?:忙了一天|忙一天|加班一天)?(?:好|很|太|有点|真的|已经)?(?:困了?|累了?|累死了|困死了|口渴|嗓子干|喉咙干)[了死]*$/u.test(text)) return /渴|嗓子|喉咙/u.test(text) ? "water" : "rest";
	return "none";
};
var InteractionStore = class {
	now;
	db;
	constructor(path, now = Date.now) {
		this.now = now;
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec("PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY, channel_hash TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL)");
	}
	snapshot(scope) {
		const row = this.db.prepare("SELECT state FROM interactions WHERE id=?").get(key(scope));
		return row ? JSON.parse(String(row.state)) : fresh();
	}
	save(scope, state) {
		this.db.prepare("INSERT OR REPLACE INTO interactions VALUES(?,?,?,?)").run(key(scope), hash(scope.channelId), JSON.stringify(state), this.now());
	}
	recordInput(state, inputId) {
		state.lastInput = inputId;
		if (inputId) state.seenInputs = [...state.seenInputs || [], inputId].slice(-32);
	}
	observe(scope, input, inputId) {
		const state = this.snapshot(scope);
		if (inputId && (state.lastInput === inputId || state.seenInputs?.includes(inputId))) return this.decision(scope);
		const scene = interactionScene(input);
		if (scene !== "none") {
			state.roleplayUntil = scene === "start" ? this.now() + 2 * HOUR : 0;
			this.recordInput(state, inputId);
			this.save(scope, state);
			return this.decision(scope);
		}
		const signal = interactionSignal(input);
		if (signal === "none" || (state.roleplayUntil || 0) > this.now() && signal !== "mute") return this.decision(scope);
		this.recordInput(state, inputId);
		if (signal === "mute") {
			state.muted = true;
			state.need = void 0;
		}
		if (signal === "resume") {
			state.muted = false;
			state.need = void 0;
		}
		if (signal === "sleep") {
			state.need = void 0;
			state.restingUntil = this.now() + 8 * HOUR;
		}
		if (signal === "water-resolved" && state.need === "water") state.need = void 0;
		if (signal === "awake") {
			if (state.need === "rest") state.need = void 0;
			state.restingUntil = 0;
		}
		if (signal === "rest" || signal === "water") {
			state.need = signal;
			state.expires = this.now() + 2 * HOUR;
		}
		this.save(scope, state);
		return this.decision(scope);
	}
	decision(scope) {
		const state = this.snapshot(scope);
		const reason = state.restingUntil > this.now() ? "resting" : state.muted ? "declined" : !state.need || state.expires <= this.now() ? "no-current-evidence" : state.lastCare && this.now() - state.lastCare < 4 * HOUR ? "cooldown" : "eligible";
		const roleplay = (state.roleplayUntil || 0) > this.now();
		return {
			reason: roleplay && reason !== "resting" && reason !== "declined" ? "roleplay" : reason,
			need: !roleplay && reason === "eligible" ? state.need : void 0,
			roleplay
		};
	}
	delivered(scope, text) {
		const decision = this.decision(scope);
		if (decision.reason !== "eligible" || /[“”「」"`]/u.test(text)) return;
		const sentences = text.split(/[。！？!?\n]|\|\|\|/u);
		const advice = decision.need === "water" ? /^(?:那|嗯|呀|哎)?[，,\s]*(?:你)?(?:先|快|记得|要不|可以|还是)?(?:去)?(?:喝|补).{0,5}(?:水|水分)/u : /^(?:那|嗯|呀|哎)?[，,\s]*(?:你)?(?:先|快|早点|快点|好好|要不|还是)?(?:去)?(?:睡|休息|歇会)/u;
		if (!sentences.some((sentence) => advice.test(sentence.trim()))) return;
		const state = this.snapshot(scope);
		state.lastCare = this.now();
		state.need = void 0;
		this.save(scope, state);
	}
	purgeHash(channelHash) {
		this.db.prepare("DELETE FROM interactions WHERE channel_hash=?").run(channelHash);
	}
	cleanup(days) {
		this.db.prepare("DELETE FROM interactions WHERE updated<?").run(this.now() - Math.max(1, Number.isFinite(days) ? days : 30) * 24 * HOUR);
	}
	close() {
		this.db.close();
	}
};
const stores = /* @__PURE__ */ new Map();
const getInteractionStore = (config) => {
	const path = join(dirname(config.workspaceRoot), "interactions.sqlite");
	let store = stores.get(path);
	if (!store) {
		store = new InteractionStore(path);
		stores.set(path, store);
	}
	return store;
};

export { InteractionStore, getInteractionStore, interactionScene, interactionSignal };