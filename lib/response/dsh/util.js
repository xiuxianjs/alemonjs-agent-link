//#region src/response/dsh/util.ts
const getSessionId = (channelId) => channelId.startsWith("private:") ? `dsh:qq:private:${channelId.slice(8)}` : `dsh:qq:group:${channelId}`;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const extractPrompt = (messageText, bot) => {
	const patterns = [new RegExp(`^\\s*<@!?${escapeRegExp(bot.UserId)}>\\s*`), new RegExp(`^\\s*\\[CQ:at,qq=${escapeRegExp(bot.UserId)}\\]\\s*`)];
	if (bot.UserName) patterns.push(new RegExp(`^\\s*@${escapeRegExp(bot.UserName)}\\s*`));
	return patterns.reduce((text, pattern) => text.replace(pattern, ""), messageText).trim();
};
const canReset = (event) => event.IsMaster || Boolean(event.IsAdmin);

//#endregion
export { canReset, extractPrompt, getSessionId };