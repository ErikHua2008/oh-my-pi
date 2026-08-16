import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ControlGuestFrame, ControlHostFrame, SessionSummary } from "@oh-my-pi/pi-wire";
import { ControlClient } from "../src/lib/control-client";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

// A control-room id is "ctrl-" + 22 base64url chars (16 random bytes); the
// result stays inside ROOM_PATH_RE's 10-64 char range. A session room id
// (bare room id) never starts with "ctrl-".
const CTRL_ROOM = "ctrl-AAAAAAAAAAAAAAAAAAAAAA";
const ROOM_KEY_B64 = encodeBase64Url(new Uint8Array(32));
// Full links append the 16-byte write token to the 32-byte room key.
const WRITE_SECRET_B64 = encodeBase64Url(new Uint8Array(48));

const CTRL_WRITE_LINK = `${CTRL_ROOM}.${WRITE_SECRET_B64}`;
const CTRL_VIEW_LINK = `${CTRL_ROOM}.${ROOM_KEY_B64}`;
const SESSION_LINK = `roomroomroom1234.${ROOM_KEY_B64}`;

const SESSIONS: SessionSummary[] = [
	{
		id: "s1",
		title: "initial",
		cwd: "/work",
		createdAt: "2026-08-11T00:00:00.000Z",
		modifiedAt: "2026-08-11T00:05:00.000Z",
		messageCount: 4,
		status: "complete",
		running: false,
		streaming: false,
		link: "wss://my.omp.sh/r/roomA.key",
	},
	{
		id: "s2",
		cwd: "/work",
		createdAt: "2026-08-11T01:00:00.000Z",
		modifiedAt: "2026-08-11T01:02:00.000Z",
		messageCount: 0,
		running: true,
		streaming: true,
	},
];

function welcomeFrame(readOnly?: true): ControlHostFrame {
	return { t: "ctrl-welcome", proto: COLLAB_PROTO, readOnly };
}

/** Clients created this run; closed in afterEach so no welcome timer leaks. */
const clients: ControlClient[] = [];
afterEach(() => {
	for (const client of clients) client.close();
	clients.length = 0;
	vi.restoreAllMocks();
});

/**
 * Build a ControlClient and capture its CollabSocket so tests can drive host
 * frames through the real socket callbacks (onOpen/onFrame/onClose) —
 * ControlClient deliberately exposes no apply-for-test seam. The socket's
 * connect() is stubbed out so no real WebSocket is opened.
 */
function makeClient(link: string, displayName = "tester"): { client: ControlClient; socket: CollabSocket } {
	let socket: CollabSocket | null = null;
	const connectSpy = vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
		socket = this;
	});
	const client = new ControlClient(link, displayName);
	clients.push(client);
	client.connect();
	connectSpy.mockRestore();
	if (socket === null) throw new Error("failed to capture the client socket");
	return { client, socket };
}

describe("ControlClient link validation", () => {
	it("throws on an invalid link", () => {
		expect(() => new ControlClient("not a link", "tester")).toThrow();
	});

	it("throws when the room is not a control room (missing ctrl- prefix)", () => {
		expect(() => new ControlClient(SESSION_LINK, "tester")).toThrow("not a control-room link");
	});
});

describe("ControlClient frame apply", () => {
	it("applies ctrl-sessions to the snapshot", () => {
		const { client, socket } = makeClient(CTRL_WRITE_LINK);
		expect(client.getSnapshot().sessions).toEqual([]);

		socket.onFrame?.({ t: "ctrl-sessions", sessions: SESSIONS }, 0);

		expect(client.getSnapshot().sessions).toEqual(SESSIONS);
	});

	it("ctrl-session replies go to onSession and leave the snapshot untouched", () => {
		const { client, socket } = makeClient(CTRL_WRITE_LINK);
		const onSession = vi.fn();
		client.onSession = onSession;
		const before = client.getSnapshot();

		socket.onFrame?.(
			{
				t: "ctrl-session",
				op: "created",
				id: "s3",
				link: "wss://my.omp.sh/r/roomX.key",
			},
			0,
		);

		expect(onSession).toHaveBeenCalledTimes(1);
		expect(onSession).toHaveBeenCalledWith({
			t: "ctrl-session",
			op: "created",
			id: "s3",
			link: "wss://my.omp.sh/r/roomX.key",
		});
		expect(client.getSnapshot()).toBe(before);
	});

	it("ctrl-error surfaces onError and leaves the snapshot untouched", () => {
		const { client, socket } = makeClient(CTRL_VIEW_LINK);
		const onError = vi.fn();
		client.onError = onError;
		const before = client.getSnapshot();

		socket.onFrame?.({ t: "ctrl-error", message: "read-only" }, 0);

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith("read-only");
		expect(client.getSnapshot()).toBe(before);
	});

	it("round-trips Codex conversation listing and import requests by request id", async () => {
		const sent: ControlGuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: ControlGuestFrame) => {
			sent.push(frame);
		});
		try {
			const { client, socket } = makeClient(CTRL_WRITE_LINK);
			const listPromise = client.listCodexSessions(true);
			const listRequest = sent.at(-1);
			if (listRequest?.t !== "ctrl-import-list") throw new Error("expected ctrl-import-list");
			expect(listRequest.archived).toBe(true);
			const source = {
				source: "codex" as const,
				id: "codex-1",
				path: "/codex/rollout.jsonl",
				cwd: "/work/project",
				title: "Imported chat",
				description: "Semantic chat summary",
				archived: true,
				createdAt: "2026-08-01T00:00:00.000Z",
				modifiedAt: "2026-08-02T00:00:00.000Z",
			};
			socket.onFrame?.({ t: "ctrl-import-list", reqId: listRequest.reqId, source: "codex", sessions: [source] }, 0);
			expect(await listPromise).toEqual([source]);

			const importPromise = client.importCodexSession(source);
			const importRequest = sent.at(-1);
			if (importRequest?.t !== "ctrl-import") throw new Error("expected ctrl-import");
			expect(importRequest).toEqual({
				t: "ctrl-import",
				reqId: importRequest.reqId,
				source: "codex",
				id: source.id,
				path: source.path,
				archived: true,
			});
			const imported = {
				id: "omp-1",
				cwd: source.cwd,
				title: source.title,
				requiresProjectSwitch: true,
			};
			socket.onFrame?.({ t: "ctrl-imported", reqId: importRequest.reqId, source: "codex", session: imported }, 0);
			expect(await importPromise).toEqual(imported);
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("rejects the matching Codex request when the host returns a correlated error", async () => {
		const sent: ControlGuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: ControlGuestFrame) => {
			sent.push(frame);
		});
		try {
			const { client, socket } = makeClient(CTRL_WRITE_LINK);
			const promise = client.listCodexSessions(false);
			const request = sent.at(-1);
			if (request?.t !== "ctrl-import-list") throw new Error("expected ctrl-import-list");
			expect(request.archived).toBe(false);
			socket.onFrame?.({ t: "ctrl-request-error", reqId: request.reqId, message: "read-only" }, 0);
			await expect(promise).rejects.toThrow("read-only");
		} finally {
			sendSpy.mockRestore();
		}
	});
});

describe("ControlClient phase transitions", () => {
	it("sends a session rename mutation with the requested title", () => {
		const sent: ControlGuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: ControlGuestFrame) => {
			sent.push(frame);
		});
		try {
			const { client } = makeClient(CTRL_WRITE_LINK);
			client.sendRename("s1", "Renamed session");
			expect(sent.at(-1)).toEqual({ t: "ctrl-rename", id: "s1", title: "Renamed session" });
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("starts connecting, goes live on welcome, and ends with a reason on bye", () => {
		const { client, socket } = makeClient(CTRL_WRITE_LINK);
		const onEnded = vi.fn();
		client.onEnded = onEnded;
		expect(client.getSnapshot().phase).toBe("connecting");
		expect(client.getSnapshot().readOnly).toBe(false);

		socket.onFrame?.(welcomeFrame(), 0);
		let snap = client.getSnapshot();
		expect(snap.phase).toBe("live");
		expect(snap.readOnly).toBe(false);

		socket.onFrame?.({ t: "ctrl-bye", reason: "core shutdown" }, 0);
		snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toBe("core shutdown");
		expect(onEnded).toHaveBeenCalledTimes(1);
		expect(onEnded).toHaveBeenCalledWith("core shutdown");

		// A later close notification belongs to the same terminal transition.
		socket.onClose?.("already closed", false);
		expect(onEnded).toHaveBeenCalledTimes(1);
	});

	it("marks readOnly for view links", () => {
		const { client, socket } = makeClient(CTRL_VIEW_LINK);
		expect(client.getSnapshot().readOnly).toBe(false);

		socket.onFrame?.(welcomeFrame(true), 0);

		const snap = client.getSnapshot();
		expect(snap.phase).toBe("live");
		expect(snap.readOnly).toBe(true);
	});

	it("a transient socket close moves to reconnecting", () => {
		const { client, socket } = makeClient(CTRL_WRITE_LINK);
		socket.onFrame?.(welcomeFrame(), 0);
		expect(client.getSnapshot().phase).toBe("live");

		socket.onClose?.("connection lost (code 1006)", true);

		expect(client.getSnapshot().phase).toBe("reconnecting");
	});

	it("sends ctrl-hello with the write token on open and ctrl-list after welcome", () => {
		const sent: ControlGuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: ControlGuestFrame) => {
			sent.push(frame);
		});
		try {
			const { client, socket } = makeClient(CTRL_WRITE_LINK);
			expect(client.getSnapshot().phase).toBe("connecting");

			socket.onOpen?.();
			expect(client.getSnapshot().phase).toBe("waiting");
			expect(sent).toEqual([
				{ t: "ctrl-hello", proto: COLLAB_PROTO, name: "tester", writeToken: expect.any(String) },
			]);

			socket.onFrame?.(welcomeFrame(), 0);
			expect(client.getSnapshot().phase).toBe("live");
			expect(sent).toHaveLength(2);
			expect(sent[1]).toEqual({ t: "ctrl-list" });
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("snapshot reference is stable between frames and replaced per applied frame", () => {
		const { client, socket } = makeClient(CTRL_WRITE_LINK);
		const before = client.getSnapshot();
		expect(client.getSnapshot()).toBe(before);

		socket.onFrame?.({ t: "ctrl-sessions", sessions: [] }, 0);

		const after = client.getSnapshot();
		expect(after).not.toBe(before);
	});
});
