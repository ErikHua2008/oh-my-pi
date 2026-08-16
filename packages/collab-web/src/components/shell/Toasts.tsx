import { CircleAlert, Info, type LucideIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { Notice } from "../../lib/client";

const INFO_TTL_MS = 1800;
const WARNING_TTL_MS = 4000;
const MAX_VISIBLE_ERRORS = 3;

const NOTICE_ICON: Record<Notice["level"], LucideIcon> = {
	info: Info,
	warning: CircleAlert,
	error: CircleAlert,
};

export function Toasts({ notices }: { notices: readonly Notice[] }): ReactNode {
	// Dynamic membership keyed by notice id — runtime collection.
	const [dismissed, setDismissed] = useState<Set<number>>(() => new Set());

	useEffect(() => {
		const timers: number[] = [];
		for (const n of notices) {
			if (n.level === "error" || dismissed.has(n.id)) continue;
			const ttl = n.level === "info" ? INFO_TTL_MS : WARNING_TTL_MS;
			const remaining = n.at + ttl - Date.now();
			timers.push(
				window.setTimeout(
					() => {
						setDismissed(prev => {
							if (prev.has(n.id)) return prev;
							const next = new Set(prev);
							next.add(n.id);
							return next;
						});
					},
					Math.max(0, remaining),
				),
			);
		}
		return () => {
			for (const t of timers) window.clearTimeout(t);
		};
	}, [notices, dismissed]);

	const visible = notices.filter(n => !dismissed.has(n.id));
	const transient = visible.filter(n => n.level !== "error").at(-1);
	const errors = visible.filter(n => n.level === "error").slice(-MAX_VISIBLE_ERRORS);
	if (transient == null && errors.length === 0) return null;

	const close = (id: number): void => {
		setDismissed(prev => {
			const next = new Set(prev);
			next.add(id);
			return next;
		});
	};

	const TransientIcon = transient == null ? null : NOTICE_ICON[transient.level];

	return (
		<>
			{transient != null && TransientIcon != null && (
				<div className="sh-toasts-transient" aria-live="polite" aria-relevant="additions">
					<div
						key={transient.id}
						className={`sh-toast sh-toast-transient sh-toast-${transient.level}`}
						role="status"
					>
						<TransientIcon className="sh-toast-icon" size={15} aria-hidden="true" />
						<span className="sh-toast-msg">{transient.message}</span>
					</div>
				</div>
			)}
			{errors.length > 0 && (
				<div className="sh-toasts-errors" aria-label="Error notifications" aria-live="assertive">
					{errors.map(n => {
						const Icon = NOTICE_ICON[n.level];
						return (
							<div key={n.id} className="sh-toast sh-toast-error" role="alert">
								<Icon className="sh-toast-icon" size={15} aria-hidden="true" />
								<span className="sh-toast-msg">{n.message}</span>
								<button
									type="button"
									className="sh-toast-close"
									onClick={() => close(n.id)}
									title="Dismiss notification"
									aria-label="Dismiss notification"
								>
									<X size={14} aria-hidden="true" />
								</button>
							</div>
						);
					})}
				</div>
			)}
		</>
	);
}
