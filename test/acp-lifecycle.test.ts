import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp/acp-client";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
	...(await original<object>()),
	spawn: mocks.spawn,
}));
vi.mock("@agentclientprotocol/sdk", async (original) => ({
	...(await original<object>()),
	client: () => {
		const app = {
			onRequest: () => app,
			onNotification: () => app,
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
		expect.objectContaining({
			clientCapabilities: expect.objectContaining({
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
