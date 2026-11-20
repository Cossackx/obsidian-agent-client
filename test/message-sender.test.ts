import { expect, it, vi } from "vitest";
import { preparePrompt } from "../src/services/message-sender";

it.each([false, true])(
	"both_prompt_paths_preserve_exact_selection (embedded=%s)",
	async (embedded) => {
		const readNote = vi.fn(async () => "before 🐙\r\nAB after");
		const result = await preparePrompt(
			{
				message: "Discuss this",
				vaultBasePath: "/synthetic",
				supportsEmbeddedContext: embedded,
				activeNote: {
					path: "folder/Note.md",
					name: "Note",
					extension: "md",
					created: 0,
					modified: 0,
					selection: {
						from: { line: 0, ch: 7 },
						to: { line: 1, ch: 2 },
					},
				},
			},
			{ readNote } as never,
			{} as never,
		);
		const outbound = JSON.stringify(result.agentContent);
		expect(outbound).toContain(JSON.stringify("🐙\r\nAB").slice(1, -1));
		expect(outbound).not.toContain("before");
		expect(outbound).not.toContain(" after");
	},
);

it("dispatch uses the captured editor selection without rereading disk", async () => {
	const readNote = vi.fn(async () => "different disk content");
	const result = await preparePrompt(
		{
			message: "Discuss this",
			vaultBasePath: "/synthetic",
			supportsEmbeddedContext: true,
			activeNote: {
				path: "folder/Note.md",
				name: "Note",
				extension: "md",
				created: 0,
				modified: 0,
				selection: {
					from: { line: 0, ch: 7 },
					to: { line: 0, ch: 13 },
					text: "TARGET",
					range: { start: 7, end: 13 },
				},
			},
		},
		{ readNote } as never,
		{} as never,
	);
	expect(result.agentContent).toContainEqual(
		matching({
			resource: matching({ text: "TARGET" }),
		}),
	);
	expect(readNote).not.toHaveBeenCalled();
});

function matching(fields: Record<string, unknown>): unknown {
	return expect.objectContaining(fields) as unknown;
}
