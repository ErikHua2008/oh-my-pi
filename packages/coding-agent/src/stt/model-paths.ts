import * as path from "node:path";

/** Absolute root containing repository-shaped STT models shipped beside a desktop executable. */
export const BUNDLED_STT_MODELS_ENV = "OMP_BUNDLED_STT_MODELS";
export const BUNDLED_STT_RUNTIME_ENV = "OMP_BUNDLED_STT_RUNTIME";

/** Resolve the optional read-only model root supplied by a native desktop host. */
export function getBundledSttModelsDir(): string | undefined {
	const configured = process.env[BUNDLED_STT_MODELS_ENV]?.trim();
	return configured ? path.resolve(configured) : undefined;
}

/** Resolve the optional Transformers/ONNX runtime shipped by a native desktop host. */
export function getBundledSttRuntimeDir(): string | undefined {
	const configured = process.env[BUNDLED_STT_RUNTIME_ENV]?.trim();
	return configured ? path.resolve(configured) : undefined;
}
