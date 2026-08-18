import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { blockNativeSurfaces } from "../../lib/native-surface-visibility";

export interface ProjectRenameDialogProps {
	name: string;
	path: string;
	onSave(name: string): Promise<void>;
	onCancel(): void;
}

/** A focused rename flow that makes it clear the project folder itself is not moved. */
export function ProjectRenameDialog({ name, path, onSave, onCancel }: ProjectRenameDialogProps): ReactNode {
	const titleId = useId();
	const descriptionId = useId();
	const errorId = useId();
	const dialogRef = useRef<HTMLFormElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;
	const [draft, setDraft] = useState(name);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const savingRef = useRef(saving);
	savingRef.current = saving;
	const returnFocusRef = useRef<HTMLElement | null>(
		typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
	);

	useEffect(() => {
		const releaseNativeSurfaces = blockNativeSurfaces();
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		inputRef.current?.focus();
		inputRef.current?.select();

		const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				if (!savingRef.current) onCancelRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
				'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
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

	const submit = async (event: FormEvent): Promise<void> => {
		event.preventDefault();
		const nextName = draft.trim();
		if (saving) return;
		if (!nextName) {
			setError("项目名称不能为空。");
			inputRef.current?.focus();
			return;
		}
		if (nextName.length > 120) {
			setError("项目名称不能超过 120 个字符。");
			inputRef.current?.focus();
			return;
		}
		if (nextName === name) {
			onCancel();
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await onSave(nextName);
			onCancel();
		} catch {
			setError("名称没有保存成功，请重试。");
			inputRef.current?.focus();
			inputRef.current?.select();
		} finally {
			setSaving(false);
		}
	};

	const keepFocusInside = (event: KeyboardEvent<HTMLFormElement>): void => {
		if (event.key === "Tab") event.stopPropagation();
	};
	const dialog = (
		<div
			className="sh-project-rename-backdrop"
			onClick={event => event.stopPropagation()}
			onPointerDown={event => {
				if (event.currentTarget === event.target && !saving) onCancel();
			}}
		>
			<form
				className="sh-project-rename-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={descriptionId}
				aria-busy={saving || undefined}
				ref={dialogRef}
				onSubmit={event => void submit(event)}
				onKeyDown={keepFocusInside}
			>
				<div className="sh-project-rename-copy">
					<h2 id={titleId}>重命名项目</h2>
					<p id={descriptionId}>只更改 Grimoire Router App 中显示的名称，不会重命名或移动硬盘上的文件夹。</p>
				</div>
				<label className="sh-project-rename-field">
					<span>项目显示名称</span>
					<input
						ref={inputRef}
						value={draft}
						maxLength={120}
						disabled={saving}
						spellCheck={false}
						onChange={event => {
							setDraft(event.currentTarget.value);
							if (error) setError(null);
						}}
						aria-invalid={error ? "true" : undefined}
						aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
					/>
				</label>
				<div className="sh-project-rename-path">
					<span>项目文件夹</span>
					<code title={path}>{path}</code>
				</div>
				{error && (
					<p className="sh-project-rename-error" id={errorId} role="alert">
						{error}
					</p>
				)}
				<div className="sh-project-rename-actions">
					<button type="button" disabled={saving} onClick={onCancel}>
						取消
					</button>
					<button type="submit" className="is-primary" disabled={saving || draft.trim().length === 0}>
						{saving ? "保存中…" : "保存"}
					</button>
				</div>
			</form>
		</div>
	);

	return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
