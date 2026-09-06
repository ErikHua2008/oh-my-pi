const SILENT_AMPLITUDE = 0.001;
const CLIPPING_AMPLITUDE = 0.98;
const QUIET_RMS = 0.008;
const CLIPPING_RATIO = 0.005;

export type SttAudioQualityKind = "good" | "quiet" | "clipping" | "unavailable";

export interface SttAudioQuality {
	quality: SttAudioQualityKind;
	/** Perceptual 0..1 level derived from -60..0 dBFS. */
	level: number;
	/** Linear peak amplitude in the analyzed window. */
	peak: number;
	/** Root mean square amplitude in the analyzed window. */
	rms: number;
	/** Fraction of samples at or above the clipping threshold. */
	clippingRatio: number;
	/** Fraction of samples indistinguishable from digital silence. */
	nearSilenceRatio: number;
	durationMs: number;
}

export function analyzeAudioQuality(samples: Float32Array, sampleRate = 16_000): SttAudioQuality {
	if (samples.length === 0 || sampleRate <= 0) {
		return {
			quality: "unavailable",
			level: 0,
			peak: 0,
			rms: 0,
			clippingRatio: 0,
			nearSilenceRatio: 1,
			durationMs: 0,
		};
	}
	let sumSquares = 0;
	let peak = 0;
	let clipped = 0;
	let nearSilent = 0;
	for (const raw of samples) {
		const sample = Number.isFinite(raw) ? Math.min(1, Math.abs(raw)) : 0;
		sumSquares += sample * sample;
		peak = Math.max(peak, sample);
		if (sample >= CLIPPING_AMPLITUDE) clipped += 1;
		if (sample < SILENT_AMPLITUDE) nearSilent += 1;
	}
	const rms = Math.sqrt(sumSquares / samples.length);
	const clippingRatio = clipped / samples.length;
	const nearSilenceRatio = nearSilent / samples.length;
	const db = rms > 0 ? 20 * Math.log10(rms) : -60;
	const level = Math.max(0, Math.min(1, (db + 60) / 60));
	const quality: SttAudioQualityKind =
		clippingRatio >= CLIPPING_RATIO ? "clipping" : rms < QUIET_RMS || nearSilenceRatio >= 0.98 ? "quiet" : "good";
	return {
		quality,
		level,
		peak,
		rms,
		clippingRatio,
		nearSilenceRatio,
		durationMs: (samples.length / sampleRate) * 1000,
	};
}
