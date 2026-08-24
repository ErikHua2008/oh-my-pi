import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
		await expect(registerGrimoireRuntimeProvider(modelRegistry, {})).resolves.toBe(false);
		expect(modelRegistry.find("grimoire", "gpt-5.5")).toBeUndefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-luna")).toBeUndefined();
	});

	test("shell mode fails before startup when the environment key is missing", async () => {
		await expect(registerGrimoireRuntimeProvider(modelRegistry, { OMP_GRIMOIRE_MODE: "1" })).rejects.toThrow(
			"GRIMOIRE_API_KEY is required",
		);
		expect(modelRegistry.find("grimoire", "gpt-5.5")).toBeUndefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-luna")).toBeUndefined();
	});

	test("shell mode registers the Grimoire Responses route from the environment", async () => {
		const apiKey = "test-grimoire-key";
		await expect(
			registerGrimoireRuntimeProvider(
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
			),
		).resolves.toBe(true);

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
		expect(await modelRegistry.getApiKeyForProvider("grimoire")).toBe(apiKey);
	});

	test("uses safe chat fallbacks when live discovery is unavailable", async () => {
		await expect(
			registerGrimoireRuntimeProvider(
				modelRegistry,
				{ OMP_GRIMOIRE_MODE: "1", GRIMOIRE_API_KEY: "test-grimoire-key" },
				{ fetch: async () => new Response(null, { status: 503 }) },
			),
		).resolves.toBe(true);

		expect(modelRegistry.find("grimoire", "gpt-5.5")).toBeDefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-luna")).toBeDefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-sol")).toBeDefined();
		expect(modelRegistry.find("grimoire", "gpt-5.6-terra")).toBeDefined();
		expect(modelRegistry.getAll().filter(model => model.provider === "grimoire")).toHaveLength(5);
	});
});
