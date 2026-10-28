import { AsyncLocalStorage } from "node:async_hooks";

// src/credentials/balance-scope.ts
const scope = new AsyncLocalStorage();
const withBalanceCheckScope = (run) => scope.getStore() ? run() : scope.run(/* @__PURE__ */ new Set(), run);
const balanceWasConfirmed = (id) => scope.getStore()?.has(id) === true;
const confirmBalance = (id) => {
	scope.getStore()?.add(id);
};

export { balanceWasConfirmed, confirmBalance, withBalanceCheckScope };