import { groupAdminStatus } from "../platform/member-role.js";
import { ResultCode, useMember } from "alemonjs";

// src/credentials/group-admin.ts
const verifyGroupKeyAdmin = async (event, lookup) => {
	if (event.IsPrivate || !event.Platform || !event.ChannelId || !event.UserId) return false;
	const status = groupAdminStatus(event);
	if (status !== null) return status;
	let timer;
	try {
		const query = lookup || (() => {
			const [member] = useMember(event);
			return member.info({ userId: event.UserId });
		});
		const result = await Promise.race([query(), new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(/* @__PURE__ */ new Error("role timeout")), 5e3);
		})]);
		const value = result.data;
		return result.code === ResultCode.Ok && value?.UserId === event.UserId && (!value.GuildId || value.GuildId === (event.GuildId || event.ChannelId)) && ["admin", "owner"].includes(value.Role || "");
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
};

export { verifyGroupKeyAdmin };