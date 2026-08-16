import { ArrowUpRight, Check, Minus, RotateCcw, X } from "lucide-react";
import { type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type AnnotationTool = "line" | "arrow";

interface AnnotationStroke {
	tool: AnnotationTool;
	startX: number;
	startY: number;
	endX: number;
	endY: number;
}

export interface ScreenshotAnnotatorProps {
	image: Blob;
	onCancel(): void;
	onComplete(image: Blob): void;
}

function drawStroke(context: CanvasRenderingContext2D, stroke: AnnotationStroke, lineWidth: number): void {
	context.save();
	context.strokeStyle = "#ef3f35";
	context.fillStyle = "#ef3f35";
	context.lineCap = "round";
	context.lineJoin = "round";
	context.lineWidth = lineWidth;
	context.beginPath();
	context.moveTo(stroke.startX, stroke.startY);
	context.lineTo(stroke.endX, stroke.endY);
	context.stroke();
	if (stroke.tool === "arrow") {
		const angle = Math.atan2(stroke.endY - stroke.startY, stroke.endX - stroke.startX);
		const head = Math.max(lineWidth * 4.5, 14);
		context.beginPath();
		context.moveTo(stroke.endX, stroke.endY);
		context.lineTo(
			stroke.endX - head * Math.cos(angle - Math.PI / 6),
			stroke.endY - head * Math.sin(angle - Math.PI / 6),
		);
		context.lineTo(
			stroke.endX - head * Math.cos(angle + Math.PI / 6),
			stroke.endY - head * Math.sin(angle + Math.PI / 6),
		);
		context.closePath();
		context.fill();
	}
	context.restore();
}

async function writeImageToClipboard(image: Blob): Promise<void> {
	if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return;
	try {
		await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
	} catch {
		// Clipboard ownership is best-effort in older WebView2 runtimes. The
		// durable Core import still proceeds when Windows rejects this write.
	}
}

export function ScreenshotAnnotator({ image, onCancel, onComplete }: ScreenshotAnnotatorProps): ReactNode {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const sourceRef = useRef<HTMLImageElement | null>(null);
	const activeStrokeRef = useRef<AnnotationStroke | null>(null);
	const [tool, setTool] = useState<AnnotationTool>("arrow");
	const [strokes, setStrokes] = useState<readonly AnnotationStroke[]>([]);
	const [ready, setReady] = useState(false);
	const [saving, setSaving] = useState(false);

	const redraw = useCallback(
		(active: AnnotationStroke | null = activeStrokeRef.current): void => {
			const canvas = canvasRef.current;
			const source = sourceRef.current;
			const context = canvas?.getContext("2d");
			if (!canvas || !source || !context) return;
			context.clearRect(0, 0, canvas.width, canvas.height);
			context.drawImage(source, 0, 0, canvas.width, canvas.height);
			const lineWidth = Math.max(3, Math.min(canvas.width, canvas.height) / 240);
			for (const stroke of strokes) drawStroke(context, stroke, lineWidth);
			if (active) drawStroke(context, active, lineWidth);
		},
		[strokes],
	);

	useEffect(() => {
		const source = new Image();
		const url = URL.createObjectURL(image);
		source.onload = () => {
			const canvas = canvasRef.current;
			if (!canvas) return;
			canvas.width = source.naturalWidth;
			canvas.height = source.naturalHeight;
			sourceRef.current = source;
			canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
			setReady(true);
		};
		source.src = url;
		return () => {
			URL.revokeObjectURL(url);
			sourceRef.current = null;
		};
	}, [image]);

	useEffect(() => {
		if (ready) redraw(null);
	}, [ready, redraw]);

	useEffect(() => {
		const close = (event: globalThis.KeyboardEvent): void => {
			if (event.key === "Escape" && !saving) onCancel();
		};
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [onCancel, saving]);

	const canvasPoint = (event: PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
		const canvas = event.currentTarget;
		const rect = canvas.getBoundingClientRect();
		return {
			x: ((event.clientX - rect.left) / rect.width) * canvas.width,
			y: ((event.clientY - rect.top) / rect.height) * canvas.height,
		};
	};

	const start = (event: PointerEvent<HTMLCanvasElement>): void => {
		if (!ready || event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		const point = canvasPoint(event);
		activeStrokeRef.current = {
			tool,
			startX: point.x,
			startY: point.y,
			endX: point.x,
			endY: point.y,
		};
	};

	const move = (event: PointerEvent<HTMLCanvasElement>): void => {
		const active = activeStrokeRef.current;
		if (!active) return;
		const point = canvasPoint(event);
		active.endX = point.x;
		active.endY = point.y;
		redraw(active);
	};

	const finish = (event: PointerEvent<HTMLCanvasElement>): void => {
		const active = activeStrokeRef.current;
		if (!active) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId);
		activeStrokeRef.current = null;
		const distance = Math.hypot(active.endX - active.startX, active.endY - active.startY);
		if (distance >= 2) setStrokes(current => [...current, { ...active }]);
		else redraw(null);
	};

	const save = async (): Promise<void> => {
		const canvas = canvasRef.current;
		if (!canvas || saving) return;
		setSaving(true);
		redraw(null);
		const result = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
		if (!result) {
			setSaving(false);
			return;
		}
		await writeImageToClipboard(result);
		onComplete(result);
	};

	return createPortal(
		<div className="sh-shot-backdrop" role="dialog" aria-modal="true" aria-label="截图标注">
			<div className="sh-shot-editor">
				<div className="sh-shot-title">截图标注</div>
				<div className="sh-shot-stage">
					<canvas
						ref={canvasRef}
						className="sh-shot-canvas"
						onPointerDown={start}
						onPointerMove={move}
						onPointerUp={finish}
						onPointerCancel={finish}
					/>
				</div>
				<div className="sh-shot-toolbar">
					<button
						type="button"
						className={tool === "line" ? "is-active" : ""}
						onClick={() => setTool("line")}
						title="直线"
					>
						<Minus size={18} />
					</button>
					<button
						type="button"
						className={tool === "arrow" ? "is-active" : ""}
						onClick={() => setTool("arrow")}
						title="箭头"
					>
						<ArrowUpRight size={18} />
					</button>
					<button
						type="button"
						disabled={strokes.length === 0}
						onClick={() => setStrokes(current => current.slice(0, -1))}
						title="撤销标注"
					>
						<RotateCcw size={17} />
					</button>
					<span className="sh-shot-spacer" />
					<button type="button" onClick={onCancel} disabled={saving} title="取消">
						<X size={18} />
					</button>
					<button
						type="button"
						className="sh-shot-confirm"
						onClick={() => void save()}
						disabled={!ready || saving}
						title="完成"
					>
						<Check size={18} />
						<span>{saving ? "保存中" : "完成"}</span>
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
