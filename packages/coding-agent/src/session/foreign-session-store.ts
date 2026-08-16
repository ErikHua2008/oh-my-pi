import type { SessionManager } from "./session-manager";

/** External coding-agent session source supported by OMP imports. */
export type ForeignSessionSource = "claude" | "codex";

/** Lightweight source metadata used to choose a foreign session before loading its transcript. */
export interface ForeignSessionInfo {
	readonly source: ForeignSessionSource;
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	readonly title?: string;
	/** Optional semantic summary shown below the source application's visible title. */
	readonly description?: string;
	/** Whether the source application considers this conversation archived. */
	readonly archived?: boolean;
	/** The source application's current visible title; transcript history must not replace it. */
	readonly titleIsAuthoritative?: boolean;
	readonly created: Date;
	readonly modified: Date;
	readonly messageCount?: number;
	readonly firstMessage?: string;
}

export interface ForeignSessionListOptions {
	/** List archived sessions instead of the active session collection. */
	readonly archived?: boolean;
}

/** Lists and converts sessions owned by another coding agent. */
export interface ForeignSessionStore {
	readonly source: ForeignSessionSource;
	/** Lists source sessions without parsing complete transcripts. */
	list(options?: ForeignSessionListOptions): Promise<ForeignSessionInfo[]>;
	/** Converts one source session into a non-persistent OMP session. */
	load(session: ForeignSessionInfo): Promise<SessionManager>;
}
