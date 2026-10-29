import { budgetEnabled, budgetRedis } from "./billing/budget.js";
import router_default from "./router.js";
import { getDSHConfig, watchDSHConfig } from "./dsh/runtime-config.js";
import { stopCredentialPool, warmCredentialPool } from "./credentials/pool.js";
import { getChatArchive } from "./history/store.js";
import { getMediaConfig } from "./media/config.js";
import { getMemoryStore } from "./memory/store.js";
import { getQAStore } from "./qa/store.js";
import { getMoodStore } from "./companion/mood.js";
import { getPlatformLedger } from "./platform/ledger.js";
import { interruptAllProactive } from "./proactive/control.js";
import { getProactiveStore } from "./proactive/store.js";
import { SessionRegistry } from "./state/registry.js";
import { ensureDSHSupervisor } from "./dsh/supervisor.js";
import { purgeGroupHashData } from "./dsh/client.js";
import { ensureStickerRoot } from "./media/stickers.js";
import { clearRecentMedia } from "./media/recent.js";
import { closeModuleRuntime, getModuleRuntime } from "./agent/modules.js";
import { autoStickerCollector } from "./media/sticker-auto.js";
import { startStickerPanel } from "./panel/sticker-panel.js";
import { defineChildren, logger, setCron } from "alemonjs";
import { writeFile } from "node:fs/promises";

// src/index.ts
let stopModuleConfigWatch;
let stickerPanel;
let panelChain = Promise.resolve();
let panelStopped = false;
const syncStickerPanel = (config) => {
	panelChain = panelChain.then(async () => {
		if (panelStopped) return;
		await stickerPanel?.close().catch(() => void 0);
		stickerPanel = void 0;
		try {
			stickerPanel = await startStickerPanel(config);
		} catch (error) {
			logger.warn({ err: error }, "Sticker panel failed to start");
		}
	});
	return panelChain;
};
var src_default = defineChildren({
	register() {
		return { response: router_default };
	},
	onCreated() {
		panelStopped = false;
		try {
			const startupConfig = getDSHConfig();
			warmCredentialPool(startupConfig);
			if (budgetEnabled(startupConfig)) budgetRedis().then(() => logger.info({
				replyGateDailyYuan: startupConfig.budget?.replyGateDailyYuan ?? 1,
				personalDailyYuan: startupConfig.budget?.personalDailyYuan ?? startupConfig.budget?.privateDailyYuan ?? 1
			}, "AgentLink Redis budget protection enabled")).catch(() => logger.error("AgentLink budget Redis unavailable; paid calls are blocked"));
			ensureStickerRoot(getMediaConfig()).catch(() => logger.warn("Default sticker library could not be prepared"));
			stopModuleConfigWatch?.();
			stopModuleConfigWatch = watchDSHConfig(() => {
				interruptAllProactive();
				autoStickerCollector.reset();
				clearRecentMedia();
				try {
					const next = getDSHConfig();
					warmCredentialPool(next);
					syncStickerPanel(next);
					getModuleRuntime(next).then((runtime) => runtime.refresh()).catch(() => logger.warn("AgentLink module configuration reload failed"));
				} catch {
					logger.warn("AgentLink module configuration is invalid");
				}
			});
			syncStickerPanel(startupConfig);
			getModuleRuntime(startupConfig).then((runtime) => runtime.refresh()).catch(() => logger.error("AgentLink module startup failed"));
			new SessionRegistry(startupConfig).ready().then(() => ensureDSHSupervisor(startupConfig)).then((supervisor) => supervisor.start()).catch(async (error) => {
				logger.error({ err: error }, "DSH bridge failed to start");
				if (process.env.AGENT_LINK_STATUS_PATH) await writeFile(process.env.AGENT_LINK_STATUS_PATH, JSON.stringify({
					phase: "failed",
					chatReady: false,
					detail: "状态库或运行环境初始化失败。"
				}), { mode: 384 }).catch(() => void 0);
			});
		} catch (error) {
			logger.error({ err: error }, "DSH bridge configuration invalid");
		}
		try {
			const cleanup = async () => {
				const config = getDSHConfig();
				getChatArchive(config).cleanup();
				getMemoryStore(config).cleanup(config.retentionDays);
				getQAStore(config).cleanup(config.retentionDays);
				getMoodStore(config).cleanup(config.retentionDays);
				getPlatformLedger(config).cleanup(config.retentionDays);
				getProactiveStore(config).cleanup(config.retentionDays);
				const registry = new SessionRegistry(config);
				let groups = await registry.expiredGroups();
				while (groups.length > 0) {
					for (const group of groups) {
						await purgeGroupHashData(config, group);
						await registry.purgeHash(group, false);
					}
					if (groups.length < 100) break;
					groups = await registry.expiredGroups();
				}
			};
			cleanup().catch((error) => logger.warn({ err: error }, "AgentLink retention cleanup failed"));
			setCron("0 * * * *", () => {
				cleanup().catch((error) => logger.warn({ err: error }, "AgentLink retention cleanup failed"));
			});
		} catch {}
	},
	onDispose() {
		interruptAllProactive();
		autoStickerCollector.reset();
		clearRecentMedia();
		stopModuleConfigWatch?.();
		stopModuleConfigWatch = void 0;
		stopCredentialPool();
		panelStopped = true;
		const closePanel = panelChain.then(async () => {
			await stickerPanel?.close().catch(() => void 0);
			stickerPanel = void 0;
		});
		return Promise.all([closePanel, closeModuleRuntime()]).then(() => void 0);
	}
});

export { src_default as default };