import { it, expect } from "vitest";
import { AcpHandler } from "../src/acp/acp-handler";

it("unsupported_file_methods_reject with the ACP method-not-found code", async () => {
	const handler = new AcpHandler(
		{} as never,
		{} as never,
		() => "",
		() => null,
		{} as never,
	);
	const params = { sessionId: "test", path: "/synthetic/file.md" };
	await expect(
		Promise.resolve().then(() => handler.readTextFile(params)),
	).rejects.toMatchObject({ code: -32601 });
	await expect(
		Promise.resolve().then(() =>
			handler.writeTextFile({ ...params, content: "synthetic" }),
		),
	).rejects.toMatchObject({ code: -32601 });
});
