import { it, expect, vi } from "vitest";
import { PermissionManager } from "../src/acp/permission-handler";

const options = [
	{ optionId: "always", name: "Allow always", kind: "allow_always" },
	{ optionId: "once", name: "Allow once", kind: "allow_once" },
];
const request = (options: unknown[]) =>
	({ sessionId: "test", toolCall: { toolCallId: "tool" }, options }) as never;

it("auto_allow_uses_explicit_once_regardless_of_order", async () => {
	const manager = new PermissionManager({ onSessionUpdate: vi.fn() }, true);
	for (const ordered of [options, [...options].reverse()]) {
		await expect(manager.request(request(ordered))).resolves.toEqual({
			outcome: { outcome: "selected", optionId: "once" },
		});
	}
});

it.each(["allow_always", "unknown", "reject_once", undefined])(
	"keeps %s in manual review",
	async (kind) => {
		const update = vi.fn();
		const manager = new PermissionManager(
			{ onSessionUpdate: update },
			true,
		);
		const response = manager.request(
			request([{ optionId: "choice", name: "Allow", kind }]),
		);
		manager.cancelAll();
		await expect(response).resolves.toEqual({
			outcome: { outcome: "cancelled" },
		});
		expect(update).toHaveBeenCalledWith(
			matching({
				permissionRequest: matching({ isActive: true }),
			}),
		);
	},
);

it("rejects an empty option list explicitly", async () => {
	const manager = new PermissionManager({ onSessionUpdate: vi.fn() }, true);
	await expect(manager.request(request([]))).rejects.toThrow(
		/no permission options/i,
	);
});

function matching(fields: Record<string, unknown>): unknown {
	return expect.objectContaining(fields) as unknown;
}
