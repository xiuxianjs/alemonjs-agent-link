import { ResultCode, useClient } from "alemonjs";

// src/social/onebot-forward.ts
const readCurrentForwards = async (event) => {
	if (event.Platform !== "onebot" || !event._ForwardIds?.length) return "";
	try {
		const [client] = useClient(event);
		const records = [];
		let remaining = 6e3;
		for (const id of [...new Set(event._ForwardIds)].slice(0, 3)) {
			if (remaining <= 0 || records.length >= 24) break;
			try {
				const result = await client.agentLink.readCurrentForward({ id });
				const rows = result?.length === 1 && result[0].code === ResultCode.Ok && Array.isArray(result[0].data?.rows) ? result[0].data.rows : void 0;
				if (!rows) {
					records.push({
						id,
						unavailable: true
					});
					continue;
				}
				const bounded = rows.slice(0, Math.max(0, 24 - records.length)).map((row) => {
					const text = row.text.slice(0, remaining);
					remaining -= text.length;
					return {
						sender: row.sender,
						text,
						attachments: row.attachments
					};
				});
				records.push(...bounded);
			} catch {
				records.push({
					id,
					unavailable: true
				});
			}
		}
		return JSON.stringify(records);
	} catch {
		return JSON.stringify([{ unavailable: true }]);
	}
};

export { readCurrentForwards };