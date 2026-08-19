import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { type DesktopBridge, desktopBridge as defaultDesktopBridge } from "../../lib/desktop-bridge";
import { useNativeTranscriptOcclusion } from "./useNativeTranscriptOcclusion";

const THINKING_LABELS: Readonly<Record<string, string>> = {
	off: "Off",
	auto: "Auto",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

export interface ThinkingPickerProps {
	levels: readonly string[];
	value: string;
	disabled?: boolean;
	desktop?: Pick<DesktopBridge, "setNativeTranscriptOcclusions">;
	onChange(level: string): void;
}

function labelFor(level: string): string {
	return THINKING_LABELS[level] ?? level;
}

/** Theme-aware thinking selector that avoids WebView2's light native select popup on Windows. */
export function ThinkingPicker({
	levels,
	value,
	disabled = false,
	desktop = defaultDesktopBridge,
	onChange,
}: ThinkingPickerProps): ReactNode {
	const [open, setOpen] = useState(false);
	const menuId = useId();
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
	useNativeTranscriptOcclusion(open, menuRef, desktop);

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	useEffect(() => {
		if (!open) return;
		const focusFrame = window.requestAnimationFrame(() => {
			itemRefs.current[Math.max(0, levels.indexOf(value))]?.focus();
		});
		const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
			triggerRef.current?.focus();
		};
		const closeOnOutsidePointer = (event: PointerEvent): void => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("keydown", closeOnEscape);
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		return () => {
			window.cancelAnimationFrame(focusFrame);
			document.removeEventListener("keydown", closeOnEscape);
			document.removeEventListener("pointerdown", closeOnOutsidePointer);
		};
	}, [open]);

	return (
		<div className="sh-thinking-picker">
			<button
				ref={triggerRef}
				type="button"
				className="sh-thinking-picker-trigger"
				disabled={disabled}
				onClick={() => setOpen(current => !current)}
				onKeyDown={event => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					setOpen(true);
				}}
				title="change thinking level"
				aria-label="thinking level"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
			>
				<span className="sh-thinking-picker-name">{labelFor(value)}</span>
				<ChevronDown size={12} aria-hidden="true" />
			</button>
			{open && (
				<div
					ref={menuRef}
					id={menuId}
					className="sh-thinking-picker-menu"
					role="menu"
					aria-label="Thinking level"
					onKeyDown={event => {
						const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null);
						if (items.length === 0) return;
						const focused =
							document.activeElement instanceof HTMLButtonElement ? items.indexOf(document.activeElement) : -1;
						let next = focused;
						if (event.key === "ArrowDown") next = (focused + 1 + items.length) % items.length;
						else if (event.key === "ArrowUp") next = (focused - 1 + items.length) % items.length;
						else if (event.key === "Home") next = 0;
						else if (event.key === "End") next = items.length - 1;
						else return;
						event.preventDefault();
						items[next]?.focus();
					}}
				>
					{levels.map((level, index) => {
						const selected = level === value;
						return (
							<button
								ref={element => {
									itemRefs.current[index] = element;
								}}
								key={level}
								type="button"
								className={
									selected ? "sh-thinking-picker-item sh-thinking-picker-on" : "sh-thinking-picker-item"
								}
								role="menuitemradio"
								aria-checked={selected}
								onClick={() => {
									setOpen(false);
									if (!selected) onChange(level);
									triggerRef.current?.focus();
								}}
							>
								<span>{labelFor(level)}</span>
								{selected && <Check size={13} aria-hidden="true" />}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
