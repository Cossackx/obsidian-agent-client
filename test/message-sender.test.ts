import { expect, it, vi } from "vitest";
import { preparePrompt } from "../src/services/message-sender";

// Follow is path-only: a legacy selection on the active note is ignored.
it.each([false, true])(
	"ignores a legacy active-note selection and sends only the path (embedded=%s)",
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
						text: "TARGET",
						range: { start: 7, end: 13 },
					},
				} as never,
			},
			{ readNote } as never,
			{} as never,
		);
		const outbound = JSON.stringify(result.agentContent);
		expect(readNote).not.toHaveBeenCalled();
		expect(outbound).toContain("folder/Note.md");
		expect(outbound).toContain("@[[Note]]\\nDiscuss this");
		for (const passage of ["TARGET", "🐙", "AB", "selected", "lines 1-2"])
			expect(outbound).not.toContain(passage);
		expect(result.agentContent.some((c) => c.type === "resource")).toBe(
			false,
		);
		expect(result.sources).toEqual([]);
		expect(result.autoMentionContext).toEqual({
			noteName: "Note",
			notePath: "folder/Note.md",
		});
	},
);
