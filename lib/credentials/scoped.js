import { getBudgetScope } from "../billing/budget.js";
import { checkedPersonalCredential, getPersonalCredential, updatePersonalKey } from "./personal.js";
import { checkedGroupCredential, getGroupCredential, updateGroupKey } from "./group.js";

// src/credentials/scoped.ts
const getBoundCredential = () => getBudgetScope()?.channelId.startsWith("private:") ? getPersonalCredential() : getGroupCredential();
const checkedBoundCredential = (signal) => getBudgetScope()?.channelId.startsWith("private:") ? checkedPersonalCredential(signal) : checkedGroupCredential(signal);
const disableBoundCredential = (credential) => credential.scope.channelId.startsWith("private:") ? updatePersonalKey(credential.scope, "disable", credential.revision) : updateGroupKey(credential.scope, credential.revision);

export { checkedBoundCredential, disableBoundCredential, getBoundCredential };