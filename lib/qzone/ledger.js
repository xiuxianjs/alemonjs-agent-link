import { BiliCommentLedger } from "../bili/comment-ledger.js";
import { join } from "node:path";

// src/qzone/ledger.ts
const stores = /* @__PURE__ */ new Map();
const qzoneLedger = (root) => {
	let store = stores.get(root);
	if (!store) {
		store = new BiliCommentLedger(join(root, "qzone"));
		stores.set(root, store);
	}
	return store;
};

export { qzoneLedger };