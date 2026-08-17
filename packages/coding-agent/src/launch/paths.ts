import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDaemonRuntimeDir, isEisdir, isEnoent } from "@oh-my-pi/pi-utils";

/** Resolve the private runtime directory shared by omp processes in one project directory. */
export { getDaemonRuntimeDir as daemonRuntimeDir };

/** Resolve aliases (notably Windows 8.3 paths) before deriving a broker scope. */
export async function canonicalDaemonProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error)) return resolved;
		throw error;
	}
}

/** Resolve the Unix socket or Windows named pipe used by one daemon broker scope. */
export function daemonBrokerEndpoint(projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		const key = Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
		return `\\\\.\\pipe\\omp-daemon-${key}`;
	}
	return path.join(runtimeDir, "broker.sock");
}
