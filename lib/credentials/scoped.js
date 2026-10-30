import { getBudgetScope, withBudgetScope } from "../billing/budget.js";
import { checkedPersonalCredential, getPersonalCredential, updatePersonalKey } from "./personal.js";
import { checkedGroupCredential, getGroupCredential, updateGroupKey } from "./group.js";

// src/credentials/scoped.ts
const ownScope = () => {
	const scope = getBudgetScope();
	return scope?.userId && !scope.autonomous && !scope.sharedOnly ? {
		...scope,
		channelId: `private:${JSON.stringify([scope.platform, scope.userId])}`
	} : null;
};
const getBoundCredential = async () => {
	if (getBudgetScope()?.channelId.startsWith("private:")) return getPersonalCredential();
	const shared = await getGroupCredential();
	const own = ownScope();
	return shared || (own ? withBudgetScope(own, getPersonalCredential) : null);
};
const checkedBoundCredential = async (signal, sharedOnly = false) => {
	if (getBudgetScope()?.channelId.startsWith("private:")) return checkedPersonalCredential(signal);
	const shared = await checkedGroupCredential(signal);
	const own = sharedOnly ? null : ownScope();
	return shared || (own ? withBudgetScope(own, () => checkedPersonalCredential(signal)) : null);
};
const disableBoundCredential = (credential) => credential.scope.channelId.startsWith("private:") ? updatePersonalKey(credential.scope, "disable", credential.revision) : updateGroupKey(credential.scope, credential.revision);

export { checkedBoundCredential, disableBoundCredential, getBoundCredential };