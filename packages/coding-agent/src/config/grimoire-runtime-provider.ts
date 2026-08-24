import { Effort } from "@oh-my-pi/pi-ai";
import { fetchOpenAICompatibleModels } from "@oh-my-pi/pi-catalog/discovery";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { ModelRegistry, ProviderConfigInput } from "./model-registry";

const GRIMOIRE_PROVIDER = "grimoire";
const GRIMOIRE_BASE_URL = "https://router.hddev.top/v1";
const GRIMOIRE_DISCOVERY_TIMEOUT_MS = 5_000;
const GRIMOIRE_FALLBACK_MODEL_IDS = ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const;

type GrimoireModelConfig = NonNullable<ProviderConfigInput["models"]>[number];

export interface GrimoireRuntimeEnvironment {
	OMP_GRIMOIRE_MODE?: string;
	GRIMOIRE_API_KEY?: string;
}

export interface GrimoireRuntimeProviderOptions {
	fetch?: FetchImpl;
	discoveryTimeoutMs?: number;
}

function isAgentModel(model: ModelSpec<"openai-responses">): boolean {
	// The shell's model picker selects the agent's chat model. Image-generation
	// entries exposed by an OpenAI-compatible /models endpoint belong in the
	// image tool, not in this picker.
	return !model.id.toLowerCase().startsWith("gpt-image-");
}

function toGrimoireModel(id: string, discoveredName?: string): GrimoireModelConfig {
	const bundled = getBundledModel<"openai-responses">("openai", id);
	if (bundled) {
		return {
			id,
			name: discoveredName && discoveredName !== id ? discoveredName : bundled.name,
			reasoning: bundled.reasoning,
			thinking: bundled.thinking,
			input: [...bundled.input],
			cost: {
				input: bundled.cost.input,
				output: bundled.cost.output,
				cacheRead: bundled.cost.cacheRead,
				cacheWrite: bundled.cost.cacheWrite,
			},
			contextWindow: bundled.contextWindow ?? 1_050_000,
			maxTokens: bundled.maxTokens ?? 128_000,
		};
	}

	// Unknown future Grimoire chat models remain usable instead of disappearing
	// until OMP's bundled catalog catches up. The neutral limits match the current
	// Grimoire GPT family and pricing remains zero when the router does not expose it.
	return {
		id,
		name: discoveredName || id,
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_050_000,
		maxTokens: 128_000,
	};
}

function fallbackModels(): GrimoireModelConfig[] {
	return GRIMOIRE_FALLBACK_MODEL_IDS.map(id => toGrimoireModel(id));
}

/**
 * Install the C++ shell's private Grimoire route without touching models.yml
 * or persisted authentication. Normal OMP launches do not carry the mode
 * marker and therefore retain their regular provider configuration.
 */
export async function registerGrimoireRuntimeProvider(
	modelRegistry: ModelRegistry,
	environment: GrimoireRuntimeEnvironment = {
		OMP_GRIMOIRE_MODE: process.env.OMP_GRIMOIRE_MODE,
		GRIMOIRE_API_KEY: process.env.GRIMOIRE_API_KEY,
	},
	options: GrimoireRuntimeProviderOptions = {},
): Promise<boolean> {
	if (environment.OMP_GRIMOIRE_MODE !== "1") return false;

	const apiKey = environment.GRIMOIRE_API_KEY?.trim();
	if (!apiKey) {
		throw new Error("GRIMOIRE_API_KEY is required when OMP_GRIMOIRE_MODE=1");
	}

	const discovered = await fetchOpenAICompatibleModels({
		api: "openai-responses",
		provider: GRIMOIRE_PROVIDER,
		baseUrl: GRIMOIRE_BASE_URL,
		apiKey,
		fetch: options.fetch,
		timeoutMs: options.discoveryTimeoutMs ?? GRIMOIRE_DISCOVERY_TIMEOUT_MS,
	});
	const liveModels = discovered?.filter(isAgentModel).map(model => toGrimoireModel(model.id, model.name));
	const models = liveModels && liveModels.length > 0 ? liveModels : fallbackModels();

	modelRegistry.registerProvider(GRIMOIRE_PROVIDER, {
		baseUrl: GRIMOIRE_BASE_URL,
		apiKey,
		api: "openai-responses",
		models,
	});
	return true;
}
