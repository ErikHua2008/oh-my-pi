import { useEffect, useSyncExternalStore } from "react";
import { desktopBridge, isCppShellHost } from "./desktop-bridge";

export const GRIMOIRE_PROVIDER = "grimoire";

let showAllModels = !isCppShellHost();
let loaded = !isCppShellHost();
let loading: Promise<void> | undefined;
let revision = 0;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

async function loadModelVisibility(): Promise<void> {
	if (loaded || !isCppShellHost()) return;
	const loadRevision = revision;
	loading ??= desktopBridge
		.loadModelVisibility()
		.then(preferences => {
			if (revision === loadRevision) showAllModels = preferences?.showAllModels === true;
		})
		.finally(() => {
			loaded = true;
			loading = undefined;
			emit();
		});
	await loading;
}

export async function setShowAllModels(next: boolean): Promise<void> {
	const previous = showAllModels;
	const saveRevision = ++revision;
	showAllModels = next;
	emit();
	if (!isCppShellHost()) return;
	try {
		await desktopBridge.saveModelVisibility({ showAllModels: next });
	} catch (error) {
		if (revision === saveRevision) {
			showAllModels = previous;
			emit();
		}
		throw error;
	}
}

export function filterModelsForGrimoire<T extends { provider: string }>(
	models: readonly T[],
	showAll: boolean,
): readonly T[] {
	if (showAll || !models.some(model => model.provider === GRIMOIRE_PROVIDER)) return models;
	return models.filter(model => model.provider === GRIMOIRE_PROVIDER);
}

export function selectDefaultGrimoireModel<T extends { provider: string; id: string }>(
	models: readonly T[],
): T | undefined {
	// Core orders the configured default first when it registers the provider.
	return models.find(model => model.provider === GRIMOIRE_PROVIDER);
}

export function useModelVisibility(): {
	showAllModels: boolean;
	setShowAllModels: (next: boolean) => Promise<void>;
	isGrimoireShell: boolean;
} {
	const value = useSyncExternalStore(
		subscribe,
		() => showAllModels,
		() => true,
	);
	useEffect(() => {
		void loadModelVisibility();
	}, []);
	return { showAllModels: value, setShowAllModels, isGrimoireShell: isCppShellHost() };
}
