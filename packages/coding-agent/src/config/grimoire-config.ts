import * as fs from "node:fs";
import * as path from "node:path";

const CONFIG_DIRECTORY = "Grimoire Router App";
const USER_CONFIG_DIRECTORY = "io.omp.cpp-shell";
const CONFIG_FILE = "config.toml";
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWED_EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FORBIDDEN_CREDENTIAL_KEYS = ["api_key", "key", "token", "experimental_bearer_token"] as const;
const ROOT_CONFIG_KEYS = new Set(["provider", "models"]);
const PROVIDER_CONFIG_KEYS = new Set(["base_url", "api", "env_key"]);
const MODEL_CONFIG_KEYS = new Set(["discover", "default", "default_effort", "exclude", "fallback"]);

export const GRIMOIRE_BUILTIN_CONFIG = {
	provider: {
		baseUrl: "https://router.hddev.top/v1",
		api: "openai-responses" as const,
		envKey: "GRIMOIRE_API_KEY",
	},
	models: {
		discover: true,
		defaultModel: "gpt-5.5",
		defaultEffort: "xhigh",
		exclude: ["gpt-image-*"] as readonly string[],
		fallback: ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as readonly string[],
	},
} as const;

export interface GrimoireConfigEnvironment {
	APPDATA?: string;
	PROGRAMDATA?: string;
	OMP_GRIMOIRE_CONFIG_PATH?: string;
	[name: string]: string | undefined;
}

export interface GrimoireConfig {
	provider: {
		baseUrl: string;
		api: "openai-responses";
		envKey: string;
	};
	models: {
		discover: boolean;
		defaultModel: string;
		defaultEffort: string;
		exclude: string[];
		fallback: string[];
	};
	loadedFiles: string[];
}

export interface LoadGrimoireConfigOptions {
	/** Lowest-to-highest precedence. Used by tests and controlled launchers. */
	configPaths?: readonly string[];
}

interface ConfigCandidate {
	path: string;
	required: boolean;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTable(root: UnknownRecord, key: string, source: string): UnknownRecord {
	const value = root[key];
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`${source}: [${key}] must be a TOML table`);
	return value;
}

function assertKnownKeys(table: UnknownRecord, allowed: ReadonlySet<string>, source: string, prefix = ""): void {
	for (const key of Object.keys(table)) {
		if (FORBIDDEN_CREDENTIAL_KEYS.some(forbidden => forbidden === key.toLowerCase())) {
			throw new Error(`${source}: do not store credentials in config; use provider.env_key`);
		}
		if (!allowed.has(key)) {
			throw new Error(`${source}: unknown Grimoire config key ${prefix}${key}`);
		}
	}
}

function readString(table: UnknownRecord, key: string, source: string): string | undefined {
	const value = table[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${source}: ${key} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${source}: ${key} must not be empty`);
	return trimmed;
}

function readBoolean(table: UnknownRecord, key: string, source: string): boolean | undefined {
	const value = table[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${source}: ${key} must be true or false`);
	return value;
}

function readStringArray(table: UnknownRecord, key: string, source: string): string[] | undefined {
	const value = table[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim().length === 0)) {
		throw new Error(`${source}: ${key} must be an array of non-empty strings`);
	}
	return [...new Set(value.map(item => (item as string).trim()))];
}

function normalizeBaseUrl(value: string, source: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${source}: provider.base_url must be an absolute HTTPS URL`);
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error(`${source}: provider.base_url must be an HTTPS URL without credentials, query, or fragment`);
	}
	return value.replace(/\/+$/, "");
}

function configCandidates(
	environment: GrimoireConfigEnvironment,
	options: LoadGrimoireConfigOptions,
): ConfigCandidate[] {
	if (options.configPaths) {
		return options.configPaths.map(configPath => ({ path: path.resolve(configPath), required: false }));
	}
	const candidates: ConfigCandidate[] = [];
	if (environment.PROGRAMDATA) {
		candidates.push({ path: path.join(environment.PROGRAMDATA, CONFIG_DIRECTORY, CONFIG_FILE), required: false });
	}
	if (environment.APPDATA) {
		candidates.push({ path: path.join(environment.APPDATA, USER_CONFIG_DIRECTORY, CONFIG_FILE), required: false });
	}
	if (environment.OMP_GRIMOIRE_CONFIG_PATH?.trim()) {
		candidates.push({ path: path.resolve(environment.OMP_GRIMOIRE_CONFIG_PATH.trim()), required: true });
	}
	return candidates;
}

function parseConfigFile(configPath: string): UnknownRecord {
	let text: string;
	try {
		text = fs.readFileSync(configPath, "utf8");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read Grimoire config ${configPath}: ${detail}`);
	}
	try {
		const parsed = Bun.TOML.parse(text);
		if (!isRecord(parsed)) throw new Error("root must be a TOML table");
		return parsed;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid Grimoire config ${configPath}: ${detail}`);
	}
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function matchesGrimoireModelPattern(modelId: string, pattern: string): boolean {
	const expression = `^${escapeRegex(pattern).replaceAll("*", ".*")}$`;
	return new RegExp(expression, "i").test(modelId);
}

export async function loadGrimoireConfig(
	environment: GrimoireConfigEnvironment = process.env,
	options: LoadGrimoireConfigOptions = {},
): Promise<GrimoireConfig> {
	let config: GrimoireConfig = {
		provider: { ...GRIMOIRE_BUILTIN_CONFIG.provider },
		models: {
			discover: GRIMOIRE_BUILTIN_CONFIG.models.discover,
			defaultModel: GRIMOIRE_BUILTIN_CONFIG.models.defaultModel,
			defaultEffort: GRIMOIRE_BUILTIN_CONFIG.models.defaultEffort,
			exclude: [...GRIMOIRE_BUILTIN_CONFIG.models.exclude],
			fallback: [...GRIMOIRE_BUILTIN_CONFIG.models.fallback],
		},
		loadedFiles: [],
	};

	for (const candidate of configCandidates(environment, options)) {
		if (!fs.existsSync(candidate.path)) {
			if (candidate.required) throw new Error(`Grimoire config does not exist: ${candidate.path}`);
			continue;
		}
		const root = parseConfigFile(candidate.path);
		assertKnownKeys(root, ROOT_CONFIG_KEYS, candidate.path);
		const provider = readTable(root, "provider", candidate.path);
		const models = readTable(root, "models", candidate.path);
		assertKnownKeys(provider, PROVIDER_CONFIG_KEYS, candidate.path, "provider.");
		assertKnownKeys(models, MODEL_CONFIG_KEYS, candidate.path, "models.");

		const baseUrl = readString(provider, "base_url", candidate.path);
		const api = readString(provider, "api", candidate.path);
		const envKey = readString(provider, "env_key", candidate.path);
		const discover = readBoolean(models, "discover", candidate.path);
		const defaultModel = readString(models, "default", candidate.path);
		const defaultEffort = readString(models, "default_effort", candidate.path)?.toLowerCase();
		const exclude = readStringArray(models, "exclude", candidate.path);
		const fallback = readStringArray(models, "fallback", candidate.path);

		if (api !== undefined && api !== "openai-responses") {
			throw new Error(`${candidate.path}: provider.api currently supports only openai-responses`);
		}
		if (envKey !== undefined && !ENVIRONMENT_NAME_PATTERN.test(envKey)) {
			throw new Error(`${candidate.path}: provider.env_key is not a valid environment variable name`);
		}
		if (defaultModel?.includes(":")) {
			throw new Error(`${candidate.path}: models.default must not include a thinking suffix`);
		}
		if (defaultEffort !== undefined && !ALLOWED_EFFORTS.has(defaultEffort)) {
			throw new Error(`${candidate.path}: models.default_effort is not supported`);
		}

		config = {
			provider: {
				baseUrl: baseUrl === undefined ? config.provider.baseUrl : normalizeBaseUrl(baseUrl, candidate.path),
				api: "openai-responses",
				envKey: envKey ?? config.provider.envKey,
			},
			models: {
				discover: discover ?? config.models.discover,
				defaultModel: defaultModel ?? config.models.defaultModel,
				defaultEffort: defaultEffort ?? config.models.defaultEffort,
				exclude: exclude ?? config.models.exclude,
				fallback: fallback ?? config.models.fallback,
			},
			loadedFiles: [...config.loadedFiles, candidate.path],
		};
	}

	if (config.models.exclude.some(pattern => matchesGrimoireModelPattern(config.models.defaultModel, pattern))) {
		throw new Error(`Grimoire default model ${config.models.defaultModel} is excluded by the active config`);
	}
	return config;
}
