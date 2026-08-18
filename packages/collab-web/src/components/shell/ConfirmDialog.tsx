import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { blockNativeSurfaces } from "../../lib/native-surface-visibility";

export interface ConfirmDialogProps {
	title: string;
	description: ReactNode;
	confirmLabel: string;
	cancelLabel?: string;
	danger?: boolean;
	busy?: boolean;
	onConfirm(): void;
	onCancel(): void;
}

/** Application-themed confirmation dialog for consequential session actions. */
export function ConfirmDialog({
	title,
	description,
	confirmLabel,
	cancelLabel = "取消",
	danger = false,
	busy = false,
	onConfirm,
	onCancel,
}: ConfirmDialogProps): ReactNode {
	const titleId = useId();
	const descriptionId = useId();
	const surfaceRef = useRef<HTMLDivElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;
	const busyRef = useRef(busy);
	busyRef.current = busy;
	const returnFocusRef = useRef<HTMLElement | null>(
		typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
	);

	useEffect(() => {
		const releaseNativeSurfaces = blockNativeSurfaces();
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		cancelRef.current?.focus();

		const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				if (!busyRef.current) onCancelRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = surfaceRef.current?.querySelectorAll<HTMLElement>(
				'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
			);
			if (!focusable || focusable.length === 0) return;
			const first = focusable.item(0);
			const last = focusable.item(focusable.length - 1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown, true);

		return () => {
			releaseNativeSurfaces();
			document.removeEventListener("keydown", handleKeyDown, true);
			document.body.style.overflow = previousOverflow;
			returnFocusRef.current?.focus();
		};
	}, []);

	const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Tab") event.stopPropagation();
	};
	const dialog = (
		<div
			className="sh-confirm-backdrop"
			onClick={event => event.stopPropagation()}
			onPointerDown={event => {
				if (event.currentTarget === event.target && !busy) onCancel();
			}}
		>
			<div
				className="sh-confirm-dialog"
				data-danger={danger ? "true" : undefined}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={descriptionId}
				ref={surfaceRef}
				onKeyDown={keepFocusInside}
			>
				<div className="sh-confirm-copy">
					<h2 id={titleId}>{title}</h2>
					<div id={descriptionId}>{description}</div>
				</div>
				<div className="sh-confirm-actions">
					<button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>
						{cancelLabel}
					</button>
					<button
						type="button"
						className={danger ? "is-danger" : "is-primary"}
						disabled={busy}
						onClick={onConfirm}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);

	return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
