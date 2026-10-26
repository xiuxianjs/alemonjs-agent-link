import router_default from "./router.js";
import { SessionRegistry } from "./state/registry.js";
import { ensureDSHSupervisor } from "./dsh/supervisor.js";
import { getDSHConfig, purgeGroupHashData } from "./dsh/client.js";
import { defineChildren, logger, setCron } from "alemonjs";

// src/index.ts
var src_default = defineChildren({
	register() {
		return { response: router_default };
	},
	onCreated() {
		try {
			ensureDSHSupervisor(getDSHConfig()).then((supervisor) => supervisor.start()).catch((error) => {
				logger.error({ err: error }, "DSH bridge failed to start");
			});
		} catch (error) {
			logger.error({ err: error }, "DSH bridge configuration invalid");
		}
		try {
			const config = getDSHConfig();
			const cleanup = async () => {
				const registry = new SessionRegistry(config);
				let groups = await registry.expiredGroups();
				while (groups.length > 0) {
					for (const group of groups) {
						await purgeGroupHashData(config, group);
						await registry.purgeHash(group);
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