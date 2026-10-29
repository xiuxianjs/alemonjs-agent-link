import { budgetRedis } from "../billing/budget.js";
import { decryptStoredKey, encryptionKey } from "./personal.js";

// src/credentials/key-balance.ts
const accountBalanceText = (data) => {
	const payload = data;
	if (payload?.code !== 0 || payload.data?.biz_code !== 0) return "查询失败，请稍后刷新";
	const summary = payload.data.biz_data;
	if (!Array.isArray(summary?.normal_wallets) || !Array.isArray(summary?.bonus_wallets)) return "暂未取得余额";
	const totals = /* @__PURE__ */ new Map();
	for (const row of [...summary.normal_wallets, ...summary.bonus_wallets]) {
		if (!["CNY", "USD"].includes(row?.currency) || typeof row.balance !== "string" || row.balance.length > 128) return "暂未取得余额";
		const match = /^(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/iu.exec(row.balance);
		if (!match) return "暂未取得余额";
		const fraction = match[3] || match[4] || "";
		const scale = 100 + Number(match[5] || 0) - fraction.length;
		if (!Number.isInteger(scale) || scale < 0 || scale > 200) return "暂未取得余额";
		const amount = BigInt(`${match[1]}${match[2] || "0"}${fraction}`) * 10n ** BigInt(scale);
		totals.set(row.currency, (totals.get(row.currency) || 0n) + amount);
	}
	if (!totals.size) return "暂未取得余额";
	return [...totals].map(([currency, amount]) => {
		const digits = (amount < 0n ? -amount : amount).toString().padStart(101, "0");
		const fraction = digits.slice(-100).replace(/0+$/u, "");
		return `${amount < 0n ? "-" : ""}${digits.slice(0, -100)}${fraction ? `.${fraction}` : ".00"} ${currency === "CNY" ? "元" : "美元"}`;
	}).join(" / ");
};
/** 展示余额不改变钥匙启停状态，也不回显服务商原始错误。 */
const storedKeyBalance = async (storageKey, scope, record) => {
	try {
		const value = record ?? JSON.parse(await (await budgetRedis()).get(storageKey) || "null");
		if (!value) return "未绑定";
		const credential = decryptStoredKey(storageKey, value, scope, await encryptionKey());
		const account = value.auth === "account";
		const response = await fetch(account ? "https://platform.deepseek.com/api/v0/users/get_user_summary" : "https://api.deepseek.com/user/balance", {
			headers: account ? { "x-dsh-auth-token": credential.apiKey } : { Authorization: `Bearer ${credential.apiKey}` },
			redirect: "error",
			signal: AbortSignal.timeout(5e3)
		});
		if (!response.ok) {
			await response.body?.cancel();
			return "查询失败，请稍后刷新";
		}
		const data = await response.json();
		if (account) return accountBalanceText(data);
		const rows = data?.balance_infos;
		if (!Array.isArray(rows) || !rows.length || rows.length > 10) return "暂未取得余额";
		const amounts = [];
		for (const row of rows) {
			if (!["CNY", "USD"].includes(row?.currency) || typeof row.total_balance !== "string" || !/^-?\d{1,16}(?:\.\d{1,12})?$/u.test(row.total_balance)) return "暂未取得余额";
			amounts.push(`${row.total_balance} ${row.currency === "CNY" ? "元" : "美元"}`);
		}
		return amounts.join(" / ");
	} catch {
		return "查询失败，请稍后刷新";
	}
};

export { accountBalanceText, storedKeyBalance };