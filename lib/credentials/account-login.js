import { startSession } from "./account-session.js";
import { accountId, getAccount, removeAccount, saveAccount } from "./account.js";
import { chromium } from "playwright-core";

// src/credentials/account-login.ts
const tasks = /* @__PURE__ */ new Map();
const loginStatus = (scope) => tasks.get(accountId(scope))?.phase;
async function cancelLogin(scope) {
	const task = tasks.get(accountId(scope));
	if (!task) return;
	task.cancelled = true;
	await task.cancel?.();
	await task.done;
}
async function loginAccount(scope, sendQr, reply) {
	const id = accountId(scope);
	if (tasks.has(id)) {
		await reply("登录正在进行，请扫描已发送的二维码；/个人登录 取消 可结束。");
		return;
	}
	if (tasks.size >= 3) {
		await reply("登录任务较多，请稍后再试。");
		return;
	}
	if (await getAccount(scope)) {
		await reply("已登录；更换账户请先发送 /个人退出。");
		return;
	}
	if (tasks.has(id) || tasks.size >= 3) {
		await reply("请稍后再试。");
		return;
	}
	let finish;
	const task = {
		cancelled: false,
		phase: "准备二维码",
		done: new Promise((resolve) => {
			finish = resolve;
		})
	};
	tasks.set(id, task);
	let session, browser;
	let groupKeyId;
	try {
		session = await startSession();
		task.cancel = () => session.dispose();
		if (task.cancelled) throw new Error("cancelled");
		browser = await chromium.launch({
			channel: "chrome",
			headless: true
		});
		const page = await (await browser.newContext({ locale: "en-US" })).newPage();
		await page.goto(session.authorizeUrl, {
			waitUntil: "domcontentloaded",
			timeout: 3e4
		});
		const qr = page.frameLocator("iframe[src^=\"https://open.weixin.qq.com/connect/qrconnect\"]").locator("img.js_qrcode_img:visible").first();
		await qr.waitFor({
			state: "visible",
			timeout: 3e4
		});
		await qr.evaluate(async (img) => {
			if (!img.complete) await new Promise((resolve, reject) => {
				img.onload = resolve;
				img.onerror = reject;
			});
			if (!img.naturalWidth) throw new Error("QR unavailable");
		});
		if (task.cancelled) throw new Error("cancelled");
		task.phase = "等待扫码授权";
		await reply("请用微信扫描二维码并确认 DeepSeek 登录。登录后预备私聊和群聊钥匙，不自动授权群；二维码失效可取消后重试。不需要发送手机号或验证码。");
		await sendQr(await qr.screenshot());
		await session.verify({ onGrant: async (token) => {
			if (task.cancelled) throw new Error("cancelled");
			task.phase = "保存登录";
			groupKeyId = await saveAccount(scope, token);
			if (task.cancelled) {
				await removeAccount(scope);
				throw new Error("cancelled");
			}
		} });
		await reply(`登录完成。私聊钥匙已准备（已有钥匙则保留）；群聊钥匙 ${groupKeyId} 已存入 /我的钥匙，暂未授权任何群。以后到目标群发送 /授权钥匙 ${groupKeyId} 即可，不使用也不影响私聊。私聊钥匙可独立启停；/个人退出 会撤销本次账户的全部用途。`);
	} catch {
		await reply(task.cancelled ? "登录已取消。" : "登录未完成，可能是二维码过期、需要额外确认或浏览器不可用。请重试；仍失败请联系主人。");
	} finally {
		await browser?.close().catch(() => void 0);
		await session?.dispose().catch(() => void 0);
		tasks.delete(id);
		finish();
	}
}

export { cancelLogin, loginAccount, loginStatus };