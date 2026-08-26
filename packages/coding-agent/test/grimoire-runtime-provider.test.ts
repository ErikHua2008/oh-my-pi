import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { registerGrimoireRuntimeProvider } from "../src/config/grimoire-runtime-provider";

describe("Grimoire C++ shell runtime provider", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `omp-grimoire-provider-${Snowflake.next()}`);
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
	});

	afterEach(() => {
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	test("normal OMP launches do not gain the shell-only provider", async () => {
		await expect(registerGrimoireRuntimeProvider(modelRegistry, {})).resolves.toBeNull();
		expect(modelRegistry.find("grimoire", "gpt-5.5")).toBeUndefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-luna")).toBeUndefined();
	});

	test("shell mode fails before startup when the environment key is missing", async () => {
		await expect(registerGrimoireRuntimeProvider(modelRegistry, { OMP_GRIMOIRE_MODE: "1" })).rejects.toThrow(
			"未配置 GRIMOIRE_API_KEY",
		);
		expect(modelRegistry.find("grimoire", "gpt-5.5")).toBeUndefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-luna")).toBeUndefined();
	});

	test("shell mode registers the Grimoire Responses route from the environment", async () => {
		const apiKey = "test-grimoire-key";
		const registration = await registerGrimoireRuntimeProvider(
			modelRegistry,
			{
				OMP_GRIMOIRE_MODE: "1",
				GRIMOIRE_API_KEY: `  ${apiKey}  `,
			},
			{
				fetch: async (_input, init) => {
					expect(init?.headers).toMatchObject({ Authorization: `Bearer ${apiKey}` });
					return Response.json({
						data: [
							{ id: "gpt-5.4" },
							{ id: "gpt-5.5" },
							{ id: "gpt-5.6-luna" },
							{ id: "gpt-5.6-sol" },
							{ id: "gpt-5.6-terra" },
							{ id: "gpt-image-2" },
						],
					});
				},
			},
		);
		expect(registration).toMatchObject({
			defaultSelector: "grimoire/gpt-5.5:xhigh",
			config: { loadedFiles: [] },
		});

		const model = modelRegistry.find("grimoire", "gpt-5.5");
		expect(model).toMatchObject({
			provider: "grimoire",
			id: "gpt-5.5",
			api: "openai-responses",
			baseUrl: "https://router.hddev.top/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_050_000,
			maxTokens: 128_000,
		});
		expect(model?.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(modelRegistry.find("grimoire", "gpt-5.6-luna")?.thinking?.efforts).toContain(Effort.Max);
		expect(modelRegistry.find("grimoire", "gpt-5.4")).toBeDefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-sol")).toBeDefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-terra")).toBeDefined();
		expect(modelRegistry.find("grimoire", "gpt-image-2")).toBeUndefined();
		expect(modelRegistry.getAll().filter(candidate => candidate.provider === "grimoire")[0]?.id).toBe("gpt-5.5");
		expect(await modelRegistry.getApiKeyForProvider("grimoire")).toBe(apiKey);
	});

	test("uses safe chat fallbacks when live discovery is unavailable", async () => {
		const registration = await registerGrimoireRuntimeProvider(
			modelRegistry,
			{ OMP_GRIMOIRE_MODE: "1", GRIMOIRE_API_KEY: "test-grimoire-key" },
			{ fetch: async () => new Response(null, { status: 503 }) },
		);
		expect(registration?.defaultSelector).toBe("grimoire/gpt-5.5:xhigh");

		expect(modelRegistry.find("grimoire", "gpt-5.5")).toBeDefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-luna")).toBeDefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-sol")).toBeDefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-terra")).toBeDefined();
		expect(modelRegistry.getAll().filter(model => model.provider === "grimoire")).toHaveLength(5);
	});

	test("layers team and user TOML without storing the key in either file", async () => {
		fs.mkdirSync(tempDir, { recursive: true });
		const teamConfig = path.join(tempDir, "team.toml");
		const userConfig = path.join(tempDir, "user.toml");
		fs.writeFileSync(
			teamConfig,
			`[provider]\nbase_url = "https://team.example/v1/"\nenv_key = "TEAM_GRIMOIRE_KEY"\n\n[models]\ndiscover = false\ndefault = "gpt-5.6-sol"\ndefault_effort = "max"\nfallback = ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra"]\n`,
		);
		fs.writeFileSync(
			userConfig,
			`[models]\ndefault = "gpt-5.6-terra"\ndefault_effort = "high"\nexclude = ["gpt-image-*", "gpt-5.4"]\n`,
		);

		const registration = await registerGrimoireRuntimeProvider(
			modelRegistry,
			{ OMP_GRIMOIRE_MODE: "1", TEAM_GRIMOIRE_KEY: "team-test-key" },
			{
				configPaths: [teamConfig, userConfig],
				fetch: async () => {
					throw new Error("discovery must stay disabled");
				},
			},
		);

		expect(registration).toMatchObject({
			defaultSelector: "grimoire/gpt-5.6-terra:high",
			config: {
				provider: { baseUrl: "https://team.example/v1", envKey: "TEAM_GRIMOIRE_KEY" },
				models: { discover: false, defaultModel: "gpt-5.6-terra" },
				loadedFiles: [teamConfig, userConfig],
			},
		});
		expect(modelRegistry.find("grimoire", "gpt-5.4")).toBeUndefined();
		expect(modelRegistry.getAll().filter(model => model.provider === "grimoire")[0]?.id).toBe("gpt-5.6-terra");
		expect(await modelRegistry.getApiKeyForProvider("grimoire")).toBe("team-test-key");
	});

	test("rejects credentials embedded directly in TOML", async () => {
		fs.mkdirSync(tempDir, { recursive: true });
		const configPath = path.join(tempDir, "unsafe.toml");
		fs.writeFileSync(configPath, `[provider]\napi_key = "must-not-be-stored"\n`);

		await expect(
			registerGrimoireRuntimeProvider(
				modelRegistry,
				{ OMP_GRIMOIRE_MODE: "1", GRIMOIRE_API_KEY: "test-grimoire-key" },
				{ configPaths: [configPath] },
			),
		).rejects.toThrow("do not store credentials in config");
	});

	test("rejects unknown TOML keys instead of silently ignoring configuration typos", async () => {
		fs.mkdirSync(tempDir, { recursive: true });
		const configPath = path.join(tempDir, "typo.toml");
		fs.writeFileSync(configPath, `[provider]\nbase-url = "https://wrong.example/v1"\n`);

		await expect(
			registerGrimoireRuntimeProvider(
				modelRegistry,
				{ OMP_GRIMOIRE_MODE: "1", GRIMOIRE_API_KEY: "test-grimoire-key" },
				{ configPaths: [configPath] },
			),
		).rejects.toThrow("unknown Grimoire config key provider.base-url");
	});

	test("rejects credential fields outside the provider table", async () => {
		fs.mkdirSync(tempDir, { recursive: true });
		const configPath = path.join(tempDir, "root-credential.toml");
		fs.writeFileSync(configPath, `token = "must-not-be-stored"\n`);

		await expect(
			registerGrimoireRuntimeProvider(
				modelRegistry,
				{ OMP_GRIMOIRE_MODE: "1", GRIMOIRE_API_KEY: "test-grimoire-key" },
				{ configPaths: [configPath] },
			),
		).rejects.toThrow("do not store credentials in config");
	});
});
