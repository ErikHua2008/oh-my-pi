import { pinyin } from "pinyin-pro";

const HAN_TEXT = /^\p{Script=Han}+$/u;
const MAX_HOTWORDS = 64;
const MAX_HOTWORD_LENGTH = 32;

function editDistance(left: string, right: string): number {
	if (left === right) return 0;
	if (left.length === 0) return right.length;
	if (right.length === 0) return left.length;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= right.length; j += 1) {
			current[j] = Math.min(
				current[j - 1]! + 1,
				previous[j]! + 1,
				previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[right.length]!;
}

function phoneticKey(text: string): string {
	return pinyin(text, { toneType: "none", type: "array" })
		.join("")
		.replace(/[^a-z]/giu, "")
		.toLowerCase();
}

/** Sanitize user/project-provided terms before sending them to the STT worker. */
export function normalizeProjectHotwords(values: readonly string[]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const word = value.trim().replace(/\s+/g, " ");
		const key = word.toLocaleLowerCase();
		if (word.length < 2 || word.length > MAX_HOTWORD_LENGTH || seen.has(key)) continue;
		seen.add(key);
		result.push(word);
		if (result.length >= MAX_HOTWORDS) break;
	}
	return result;
}

/**
 * Apply a deliberately constrained homophone correction pass to Paraformer
 * output. Only manually supplied all-Han terms are considered, replacement
 * spans must have the same character count, and their tone-free pinyin must be
 * very close. This boosts project names without allowing a language model to
 * rewrite dictated content.
 */
export function applyProjectHotwords(text: string, values: readonly string[]): string {
	let corrected = text;
	const hotwords = normalizeProjectHotwords(values)
		.filter(word => HAN_TEXT.test(word))
		.sort((left, right) => right.length - left.length);
	for (const hotword of hotwords) {
		if (corrected.includes(hotword)) continue;
		const targetKey = phoneticKey(hotword);
		if (!targetKey) continue;
		const maxDistance = Math.max(1, Math.floor(targetKey.length * 0.28));
		let offset = 0;
		while (offset <= corrected.length - hotword.length) {
			const candidate = corrected.slice(offset, offset + hotword.length);
			if (candidate !== hotword && HAN_TEXT.test(candidate)) {
				const candidateKey = phoneticKey(candidate);
				if (candidateKey && editDistance(candidateKey, targetKey) <= maxDistance) {
					corrected = `${corrected.slice(0, offset)}${hotword}${corrected.slice(offset + hotword.length)}`;
					offset += hotword.length;
					continue;
				}
			}
			offset += 1;
		}
	}
	return corrected;
}
