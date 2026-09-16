import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:process";

//#region src/dsh/credentials.ts
const execFileAsync = promisify(execFile);
const service = "alemonjs-agent-link";
const account = "dsh-model-credentials";
let cachedCredentials;
const swiftLoad = `
import Foundation
import Security
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: CommandLine.arguments[1],
  kSecAttrAccount as String: CommandLine.arguments[2],
  kSecReturnData as String: true,
  kSecMatchLimit as String: kSecMatchLimitOne
]
var result: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &result)
if status == errSecItemNotFound { exit(2) }
guard status == errSecSuccess, let data = result as? Data else { exit(1) }
FileHandle.standardOutput.write(data)
`;
const swiftSave = `
import Foundation
import Security
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: CommandLine.arguments[1],
  kSecAttrAccount as String: CommandLine.arguments[2]
]
let data = FileHandle.standardInput.readDataToEndOfFile()
let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
if status == errSecItemNotFound {
  var item = query
  item[kSecValueData as String] = data
  if SecItemAdd(item as CFDictionary, nil) != errSecSuccess { exit(1) }
} else if status != errSecSuccess { exit(1) }
`;
const swiftRemove = `
import Foundation
import Security
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: CommandLine.arguments[1],
  kSecAttrAccount as String: CommandLine.arguments[2]
]
let status = SecItemDelete(query as CFDictionary)
if status != errSecSuccess && status != errSecItemNotFound { exit(1) }
`;
const encode = (credentials) => JSON.stringify(credentials);
const decode = (value) => {
	try {
		const parsed = JSON.parse(value);
		return typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? {
			apiKey: parsed.apiKey,
			baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : void 0,
			model: typeof parsed.model === "string" ? parsed.model : void 0
		} : null;
	} catch {
		return null;
	}
};
const requireKeychain = () => {
	if (platform !== "darwin") throw new Error("当前系统未配置受支持的系统密钥库。");
};
const runSwiftWithSecret = (script, secret) => new Promise((resolve, reject) => {
	const child = spawn("/usr/bin/swift", [
		"-e",
		script,
		service,
		account
	], { stdio: [
		"pipe",
		"ignore",
		"pipe"
	] });
	let stderr = "";
	child.stderr?.on("data", (data) => {
		stderr += String(data);
	});
	child.once("error", () => reject(/* @__PURE__ */ new Error("系统密钥库不可用。")));
	child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || "系统密钥库操作失败。")));
	child.stdin?.end(secret);
});
const getDSHCredentials = async () => {
	requireKeychain();
	if (cachedCredentials !== void 0) return cachedCredentials;
	try {
		const { stdout } = await execFileAsync("/usr/bin/swift", [
			"-e",
			swiftLoad,
			service,
			account
		]);
		cachedCredentials = decode(stdout.trim());
		return cachedCredentials;
	} catch {
		cachedCredentials = null;
		return null;
	}
};
const saveDSHCredentials = async (credentials) => {
	requireKeychain();
	if (!credentials.apiKey.trim()) throw new Error("API Key 不能为空。");
	await runSwiftWithSecret(swiftSave, encode(credentials));
	cachedCredentials = { ...credentials };
};
const removeDSHCredentials = async () => {
	requireKeychain();
	await runSwiftWithSecret(swiftRemove);
	cachedCredentials = null;
};

//#endregion
export { getDSHCredentials, removeDSHCredentials, saveDSHCredentials };