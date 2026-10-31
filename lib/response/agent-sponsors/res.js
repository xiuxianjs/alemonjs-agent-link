import { getSponsors } from "../../sponsors/config.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { detailBubbles, sectionBubble } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-sponsors/res.ts
var res_default = async () => {
	const sponsors = getSponsors();
	if (!sponsors.enabled) return;
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!context.match.selects) return;
	const [route] = useRoute();
	const [message] = useMessage();
	const items = sponsors.items.filter((item) => item.enabled);
	if (route.rawArgs[0] === "详情") {
		const item = route.rawArgs.length === 2 ? items.find((row) => row.id === route.rawArgs[1]) : void 0;
		const page = item ? Math.floor(items.indexOf(item) / 5) + 1 : 1;
		const actions = [...item?.url ? [{
			label: "了解详情",
			url: item.url
		}] : [], {
			label: "返回列表",
			command: `/赞助列表 ${page}`
		}];
		for (const format of detailBubbles(item ? `${item.title}\n${item.content}` : "该赞助条目不存在或已下架，请返回列表重新选择。", "赞助详情", {
			platform: context.current.Platform,
			actions
		})) assertMessageDelivered(await message.send({ format }));
		return;
	}
	const pages = Math.ceil(items.length / 5) || 1;
	const page = Math.max(1, Math.min(pages, Math.floor(Number(route.rawArgs[0])) || 1));
	const actions = [
		...page > 1 ? [{
			label: "上一页",
			command: `/赞助列表 ${page - 1}`
		}] : [],
		...page < pages ? [{
			label: "下一页",
			command: `/赞助列表 ${page + 1}`
		}] : [],
		{
			label: "查看额度",
			command: "/额度"
		}
	];
	await message.send({ format: sectionBubble("赞助列表", `感谢支持 · 第${page}/${pages}页`, items.length ? items.slice((page - 1) * 5, page * 5).map((item) => ({
		title: item.title,
		text: `${Array.from(item.content).slice(0, 80).join("")}${Array.from(item.content).length > 80 ? "…" : ""}`,
		actions: [{
			label: "查看详情",
			command: `/赞助列表 详情 ${item.id}`
		}]
	})) : [{
		title: "暂无赞助",
		text: "暂时没有展示的赞助条目。"
	}], {
		platform: context.current.Platform,
		actions
	}) });
};

export { res_default as default };