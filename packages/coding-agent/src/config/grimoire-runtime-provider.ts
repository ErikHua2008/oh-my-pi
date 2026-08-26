import { Effort } from "@oh-my-pi/pi-ai";
import { fetchOpenAICompatibleModels } from "@oh-my-pi/pi-catalog/discovery";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import {
	type GrimoireConfig,
	type GrimoireConfigEnvironment,
	loadGrimoireConfig,
	matchesGrimoireModelPattern,
} from "./grimoire-config";
import type { ModelRegistry, ProviderConfigInput } from "./model-registry";

const GRIMOIRE_PROVIDER = "grimoire";
const GRIMOIRE_DISCOVERY_TIMEOUT_MS = 5_000;

type GrimoireModelConfig = NonNullable<ProviderConfigInput["models"]>[number];

export interface GrimoireRuntimeEnvironment extends GrimoireConfigEnvironment {
	OMP_GRIMOIRE_MODE?: string;
}

export interface GrimoireRuntimeProviderOptions {
	fetch?: FetchImpl;
	discoveryTimeoutMs?: number;
	configPaths?: readonly string[];
}

export interface GrimoireRuntimeProviderRegistration {
	config: GrimoireConfig;
	defaultSelector: string;
}

function isAgentModel(model: ModelSpec<"openai-responses">, config: GrimoireConfig): boolean {
	return !config.models.exclude.some(pattern => matchesGrimoireModelPattern(model.id, pattern));
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

function orderedModels(models: readonly GrimoireModelConfig[], config: GrimoireConfig): GrimoireModelConfig[] {
	const byId = new Map(models.map(model => [model.id, model]));
	byId.set(
		config.models.defaultModel,
		byId.get(config.models.defaultModel) ?? toGrimoireModel(config.models.defaultModel),
	);
	return [
		byId.get(config.models.defaultModel)!,
		...[...byId.values()].filter(model => model.id !== config.models.defaultModel),
	];
}

function fallbackModels(config: GrimoireConfig): GrimoireModelConfig[] {
	return orderedModels(
		config.models.fallback
			.filter(id => !config.models.exclude.some(pattern => matchesGrimoireModelPattern(id, pattern)))
			.map(id => toGrimoireModel(id)),
		config,
	);
}

/**
 * Install the C++ shell's private Grimoire route without touching models.yml
 * or persisted authentication. Normal OMP launches do not carry the mode
 * marker and therefore retain their regular provider configuration.
 */
export async function registerGrimoireRuntimeProvider(
	modelRegistry: ModelRegistry,
	environment: GrimoireRuntimeEnvironment = process.env,
	options: GrimoireRuntimeProviderOptions = {},
): Promise<GrimoireRuntimeProviderRegistration | null> {
	if (environment.OMP_GRIMOIRE_MODE !== "1") return null;

	const config = await loadGrimoireConfig(environment, { configPaths: options.configPaths });
	const apiKey = environment[config.provider.envKey]?.trim();
	if (!apiKey) {
		throw new Error(
			`未配置 ${config.provider.envKey}。Grimoire Router App 只从该环境变量读取凭据，不会在配置文件中保存 Key。`,
		);
	}

	const discovered = config.models.discover
		? await fetchOpenAICompatibleModels({
				api: config.provider.api,
				provider: GRIMOIRE_PROVIDER,
				baseUrl: config.provider.baseUrl,
				apiKey,
				fetch: options.fetch,
				timeoutMs: options.discoveryTimeoutMs ?? GRIMOIRE_DISCOVERY_TIMEOUT_MS,
			})
		: null;
	const liveModels = discovered
		?.filter(model => isAgentModel(model, config))
		.map(model => toGrimoireModel(model.id, model.name));
	const models = liveModels && liveModels.length > 0 ? orderedModels(liveModels, config) : fallbackModels(config);

	modelRegistry.registerProvider(GRIMOIRE_PROVIDER, {
		baseUrl: config.provider.baseUrl,
		apiKey,
		api: config.provider.api,
		models,
	});
	return {
		config,
		defaultSelector: `${GRIMOIRE_PROVIDER}/${config.models.defaultModel}:${config.models.defaultEffort}`,
	};
}
