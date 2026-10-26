import router_default from "./router.js";
import { getChatArchive } from "./history/store.js";
import { getMemoryStore } from "./memory/store.js";
import { SessionRegistry } from "./state/registry.js";
import { ensureDSHSupervisor } from "./dsh/supervisor.js";
import { getDSHConfig, purgeGroupHashData } from "./dsh/client.js";
import { getModuleRuntime } from "./agent/modules.js";
import { writeFile } from "node:fs/promises";
import { defineChildren, logger, setCron } from "alemonjs";

// src/index.ts
var src_default = defineChildren({
	register() {
		return { response: router_default };
	},
	onCreated() {
		try {
			const startupConfig = getDSHConfig();
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
	}
});

export { src_default as default };