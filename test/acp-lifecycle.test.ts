import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp/acp-client";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	connect: vi.fn(),
	notification: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<object>()),
	spawn: mocks.spawn,
}));
vi.mock("@agentclientprotocol/sdk", async (original) => ({
	...(await original<object>()),
	client: () => {
		const app = {
			onRequest: () => app,
			onNotification: (method: string, handler: unknown) => {
				mocks.notification(method, handler);
				return app;
			},
			connect: mocks.connect,
		};
		return app;
	},
}));

const config = {
	id: "fixture",
	displayName: "Fixture",
	command: "fixture-agent",
	args: [],
	workingDirectory: "/synthetic",
};
const makeClient = () =>
	new AcpClient({ settings: {}, manifest: { version: "0.0.0" } } as never);

function fakeChild(pipe = true) {
	const child = Object.assign(new EventEmitter(), {
		stdin: pipe ? new PassThrough() : null,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null as number | null,
		signalCode: null,
		pid: undefined,
		kill: vi.fn(() => {
			queueMicrotask(() => {
				child.exitCode = 0;
				child.emit("exit", 0, null);
			});
			return true;
		}),
	});
	mocks.spawn.mockReturnValueOnce(child);
	return child;
}

function connection(error?: Error) {
	const controller = new AbortController();
	const request = vi.fn(async () => {
		if (error) throw error;
		return { protocolVersion: 1, agentCapabilities: {} };
	});
	const close = vi.fn(() => controller.abort());
	mocks.connect.mockReturnValueOnce({
		agent: { request },
		close,
		signal: controller.signal,
		closed: Promise.resolve(),
	});
	return { close, request };
}

beforeEach(() => {
	mocks.spawn.mockReset();
	mocks.connect.mockReset();
	mocks.notification.mockReset();
});

it("failed_initialize_releases_only_owned_resources and ignores late old-process events", async () => {
	const otherChild = fakeChild();
	const otherConnection = connection();
	const other = makeClient();
	await other.initialize(config);
	const first = fakeChild();
	const failure = new Error("synthetic handshake failure");
	const firstConnection = connection(failure);
	const client = makeClient();
	const update = vi.fn();
	client.onSessionUpdate(update);
	await expect(client.initialize(config)).rejects.toBe(failure);
	expect(first.kill).toHaveBeenCalledTimes(1);
	expect(first.exitCode).toBe(0);
	expect(firstConnection.close).toHaveBeenCalledTimes(1);
	expect(otherChild.kill).not.toHaveBeenCalled();
	expect(otherConnection.close).not.toHaveBeenCalled();
	fakeChild();
	const successor = connection();
	await client.initialize(config);
	first.emit("exit", 127, null);
	expect(update).not.toHaveBeenCalled();
	expect(client.isInitialized()).toBe(true);
	expect(successor.request).toHaveBeenCalledWith(
		"initialize",
		matching({
			clientCapabilities: matching({
				fs: { readTextFile: false, writeTextFile: false },
			}),
		}),
	);
	await client.disconnect();
	await other.disconnect();
});

it.each([false, true])(
	"releases a partial launch when pipes are %s",
	async (hasPipes) => {
		const child = fakeChild(hasPipes);
		mocks.connect.mockImplementationOnce(() => {
			throw new Error("connection construction failed");
		});
		const client = makeClient();
		await expect(client.initialize(config)).rejects.toThrow(
			hasPipes ? "connection construction failed" : "stdin/stdout",
		);
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.exitCode).toBe(0);
		expect(client.isInitialized()).toBe(false);
	},
);

it.each(["load", "resume"] as const)(
	"keeps %s replay provisional, discards rejected updates and publishes a successful restore once",
	async (method) => {
		fakeChild();
		const { request } = connection();
		const client = makeClient();
		const received = vi.fn();
		client.onSessionUpdate(received);
		try {
			await client.initialize(config);
			request.mockResolvedValueOnce({ sessionId: "previous" } as never);
			await client.newSession(config.workingDirectory);
			const update = mocks.notification.mock.calls.find(
				([name]) => name === "session/update",
			)?.[1] as (notification: unknown) => Promise<void>;
			const replay = (sessionId: string) =>
				update({
					params: {
						sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: {
								type: "text",
								text: `Reply for ${sessionId}`,
							},
						},
					},
				});
			const restore = (id: string) =>
				method === "load"
					? client.loadSession(id, config.workingDirectory)
					: client.resumeSession(id, config.workingDirectory);
			request.mockImplementationOnce(async () => {
				await replay("refused");
				throw new Error("Unknown session");
			});
			await expect(restore("refused")).rejects.toThrow("Unknown session");
			await replay("refused");
			expect(received).not.toHaveBeenCalled();
			expect(client.getConfirmedSessionId()).toBe("previous");
			request.mockImplementationOnce(async () => {
				await replay("accepted");
				return { protocolVersion: 1, agentCapabilities: {} };
			});
			const restored = await restore("accepted");
			expect(received).not.toHaveBeenCalled();
			expect(client.getConfirmedSessionId()).toBe("accepted");
			restored.publishUpdates();
			restored.publishUpdates();
			expect(received).toHaveBeenCalledExactlyOnceWith({
				text: "Reply for accepted",
				type: "agent_message_chunk",
				sessionId: "accepted",
			});
		} finally {
			await client.disconnect();
		}
	},
);

function matching(fields: Record<string, unknown>): unknown {
	return expect.objectContaining(fields) as unknown;
}
