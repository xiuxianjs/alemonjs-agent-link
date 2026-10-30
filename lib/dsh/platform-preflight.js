import { release } from "node:os";

// src/dsh/platform-preflight.ts
const agentPlatformIssue = (platform = process.platform, arch = process.arch, osRelease = release(), glibc = (process.report?.getReport())?.header?.glibcVersionRuntime) => {
	if (platform === "win32") return "Windows 原生尚不支持完整 Agent 沙箱。请以管理员身份运行 wsl --install，按提示重启，然后在 WSL2 内安装 Node.js 并运行本项目。";
	if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) return "当前系统或 CPU 架构不支持完整 Agent；请使用 macOS 14+ 或 Linux glibc 2.28+ 的 x64/arm64 环境。";
	if (platform === "darwin" && Number(osRelease.split(".")[0]) < 23) return "当前 DSH 运行包需要 macOS 14 或更新版本，请升级系统后重试。";
	if (platform === "linux") {
		const [major, minor] = (glibc ?? "0.0").split(".").map(Number);
		if (!(major > 2 || major === 2 && minor >= 28)) return "当前 DSH 运行包需要 glibc 2.28+；Alpine/musl 不支持，请使用兼容的 Ubuntu 或 Debian 环境。";
	}
};

export { agentPlatformIssue };