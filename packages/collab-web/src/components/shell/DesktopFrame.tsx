import { ArrowLeft, ArrowRight, Minus, PanelLeft, Square, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type DesktopWindowAction, desktopBridge, isCppShellHost } from "../../lib/desktop-bridge";
import { useSystemTheme } from "../../lib/theme";
import { useNativeTranscriptOcclusion } from "./useNativeTranscriptOcclusion";

type MenuName = "file" | "edit" | "view" | "help";

interface DesktopFrameProps {
	children: ReactNode;
	canGoBack?: boolean;
	onBack?(): void;
}

interface MenuItem {
	label: string;
	action: DesktopWindowAction;
	shortcut?: string;
	separatorBefore?: boolean;
}

const MENUS: Readonly<Record<MenuName, readonly MenuItem[]>> = {
	file: [
		{ label: "Open Project…", action: "open_project", shortcut: "Ctrl+O" },
		{ label: "Exit", action: "exit", separatorBefore: true },
	],
	edit: [
		{ label: "Undo", action: "undo", shortcut: "Ctrl+Z" },
		{ label: "Redo", action: "redo", shortcut: "Ctrl+Y" },
		{ label: "Cut", action: "cut", shortcut: "Ctrl+X", separatorBefore: true },
		{ label: "Copy", action: "copy", shortcut: "Ctrl+C" },
		{ label: "Paste", action: "paste", shortcut: "Ctrl+V" },
		{ label: "Select All", action: "select_all", shortcut: "Ctrl+A" },
	],
	view: [
		{ label: "Reload", action: "reload", shortcut: "Ctrl+R" },
		{ label: "Native high-speed transcript", action: "toggle_native_transcript" },
	],
	help: [{ label: "About Grimoire Router App", action: "about" }],
};

const RESIZE_HANDLES: readonly { edge: string; action: DesktopWindowAction }[] = [
	{ edge: "top", action: "resize_top" },
	{ edge: "right", action: "resize_right" },
	{ edge: "bottom", action: "resize_bottom" },
	{ edge: "left", action: "resize_left" },
	{ edge: "top-left", action: "resize_top_left" },
	{ edge: "top-right", action: "resize_top_right" },
	{ edge: "bottom-right", action: "resize_bottom_right" },
	{ edge: "bottom-left", action: "resize_bottom_left" },
];

function menuLabel(menu: MenuName): string {
	return menu[0].toUpperCase() + menu.slice(1);
}

export function DesktopFrame({ children, canGoBack = false, onBack }: DesktopFrameProps): ReactNode {
	const [openMenu, setOpenMenu] = useState<MenuName | null>(null);
	const menuPopupRef = useRef<HTMLDivElement | null>(null);
	const nativeFrame = isCppShellHost();
	const theme = useSystemTheme();
	useNativeTranscriptOcclusion(nativeFrame && openMenu !== null, menuPopupRef, desktopBridge, openMenu);

	useEffect(() => {
		if (nativeFrame) void desktopBridge.setWindowTheme(theme);
	}, [nativeFrame, theme]);

	useEffect(() => {
		if (!nativeFrame || openMenu === null) return;
		const close = (event: PointerEvent): void => {
			if (!(event.target instanceof Element) || event.target.closest(".sh-desktop-menu") === null) setOpenMenu(null);
		};
		const closeOnEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpenMenu(null);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [nativeFrame, openMenu]);

	if (!nativeFrame) return children;

	const run = (action: DesktopWindowAction): void => {
		setOpenMenu(null);
		void desktopBridge.runWindowAction(action);
	};

	return (
		<div className="sh-desktop-frame">
			{RESIZE_HANDLES.map(handle => (
				<div
					key={handle.edge}
					className={`sh-desktop-resize sh-desktop-resize-${handle.edge}`}
					aria-hidden="true"
					onPointerDown={event => {
						if (event.button !== 0) return;
						event.preventDefault();
						event.stopPropagation();
						run(handle.action);
					}}
				/>
			))}
			<header className="sh-desktop-titlebar">
				<div className="sh-desktop-nav">
					<button
						type="button"
						className="sh-desktop-icon"
						onClick={() => window.dispatchEvent(new CustomEvent("omp-toggle-sidebar"))}
						aria-label="Toggle sidebar"
						title="Toggle sidebar"
					>
						<PanelLeft size={14} aria-hidden="true" />
					</button>
					<button
						type="button"
						className="sh-desktop-icon"
						onClick={onBack}
						disabled={!canGoBack}
						aria-label="Back"
						title="Back"
					>
						<ArrowLeft size={14} aria-hidden="true" />
					</button>
					<button type="button" className="sh-desktop-icon" disabled aria-label="Forward" title="Forward">
						<ArrowRight size={14} aria-hidden="true" />
					</button>
				</div>
				<nav className="sh-desktop-menus" aria-label="Application menu">
					{(Object.keys(MENUS) as MenuName[]).map(menu => (
						<div key={menu} className="sh-desktop-menu">
							<button
								type="button"
								className="sh-desktop-menu-trigger"
								onClick={() => setOpenMenu(current => (current === menu ? null : menu))}
								aria-haspopup="menu"
								aria-expanded={openMenu === menu}
							>
								{menuLabel(menu)}
							</button>
							{openMenu === menu && (
								<div ref={menuPopupRef} className="sh-desktop-menu-popup" role="menu">
									{MENUS[menu].map(item => (
										<button
											key={item.action}
											type="button"
											className={
												item.separatorBefore
													? "sh-desktop-menu-item sh-desktop-menu-separated"
													: "sh-desktop-menu-item"
											}
											onClick={() => run(item.action)}
											role="menuitem"
										>
											<span>{item.label}</span>
											{item.shortcut && <kbd>{item.shortcut}</kbd>}
										</button>
									))}
								</div>
							)}
						</div>
					))}
				</nav>
				<div
					className="sh-desktop-drag"
					onPointerDown={event => {
						if (event.button === 0) void desktopBridge.runWindowAction("drag");
					}}
					onDoubleClick={() => void desktopBridge.runWindowAction("toggle_maximize")}
				/>
				<div className="sh-desktop-window-controls">
					<button type="button" onClick={() => run("minimize")} aria-label="Minimize" title="Minimize">
						<Minus size={14} aria-hidden="true" />
					</button>
					<button type="button" onClick={() => run("toggle_maximize")} aria-label="Maximize" title="Maximize">
						<Square size={12} aria-hidden="true" />
					</button>
					<button
						type="button"
						className="sh-desktop-close"
						onClick={() => run("close")}
						aria-label="Close"
						title="Close"
					>
						<X size={15} aria-hidden="true" />
					</button>
				</div>
			</header>
			<div className="sh-desktop-content">{children}</div>
		</div>
	);
}
