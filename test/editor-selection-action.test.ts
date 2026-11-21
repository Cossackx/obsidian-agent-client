import { expect, it, vi } from "vitest";
import {
	captureEditorSelection,
	stageEditorSelection,
	type SelectionStage,
} from "../src/services/editor-selection-action";
import { VaultService } from "../src/services/vault-service";

const buffer = "Top\r\n😀 exact\r\nEnd";
function fixture() {
	let resolve!: () => void;
	const pending = new Promise<void>((done) => {
		resolve = done;
	});
	const state = {
		path: "Original.md",
		text: buffer,
		owner: "A",
		from: { line: 1, ch: 0 },
		to: { line: 2, ch: 0 },
	};
	const editor = {
		getValue: () => state.text,
		getCursor: (which: "from" | "to") => state[which],
	};
	const callback = vi.fn<SelectionStage>(async () => undefined);
	const activate = vi.fn(async () => {
		const owner = state.owner;
		await pending;
		return { stage: callback, owns: () => state.owner === owner };
	});
	const stage = (purpose: "ask" | "suggest-edit" = "ask") =>
		stageEditorSelection(
			editor,
			state.path,
			purpose,
			activate,
			() => state.path === "Original.md",
		);
	return { state, editor, callback, activate, stage, resolve };
}

it("freezes the precise UTF-16 selection before a deferred chat focus clears it", async () => {
	const f = fixture();
	const result = f.stage("suggest-edit");
	f.state.to = f.state.from;
	f.resolve();
	await result;
	expect(f.callback).toHaveBeenCalledOnce();
	const [source, range, purpose, check] = f.callback.mock.calls[0];
	expect(source.path).toBe("Original.md");
	expect(source.text).toBe(buffer);
	expect(Number.isFinite(source.capturedAt)).toBe(true);
	expect(range).toEqual({ start: 5, end: 15 });
	expect(purpose).toBe("suggest-edit");
	expect(typeof check).toBe("function");
});

it.each(["text", "path", "owner"] as const)(
	"does not stage or fall back when the captured %s changes during activation",
	async (key) => {
		const f = fixture();
		const result = f.stage();
		f.state[key] = "Changed.md";
		f.resolve();
		await expect(result).rejects.toThrow(/changed/i);
		expect(f.callback).not.toHaveBeenCalled();
	},
);

it.each(["empty", "non-Markdown"])(
	"rejects %s selections before activation",
	async (kind) => {
		const f = fixture();
		if (kind === "empty") f.state.to = f.state.from;
		else f.state.path = "Drawing.canvas";
		await expect(f.stage()).rejects.toThrow(/select text/i);
		expect(f.activate).not.toHaveBeenCalled();
	},
);

it("uses the menu-opening snapshot even if the menu clears the selection before click", async () => {
	const f = fixture();
	const capture = captureEditorSelection(f.editor, f.state.path);
	f.state.to = f.state.from;
	const result = stageEditorSelection(
		f.editor,
		f.state.path,
		"ask",
		f.activate,
		() => true,
		capture,
	);
	f.resolve();
	await result;
	expect(f.callback).toHaveBeenCalledWith(
		capture.source,
		capture.range,
		"ask",
		expect.any(Function),
	);
});

it("stops if the target view has no registered composer", async () => {
	const f = fixture();
	await expect(
		stageEditorSelection(
			f.editor,
			f.state.path,
			"ask",
			async () => undefined,
			() => true,
		),
	).rejects.toThrow(/open and focus the target conversation/i);
});

it("R5 unsubscribing the last view leaves no workspace or editor listener", () => {
	const refs: object[] = [];
	const on = vi.fn((name: string) => {
		const ref = { name };
		refs.push(ref);
		return ref;
	});
	const offref = vi.fn((_ref: object) => undefined);
	const app = {
		vault: { getMarkdownFiles: () => [], on: () => ({}) },
		workspace: { on, offref },
	};
	const svc = new VaultService({ app } as never);
	const offA = svc.subscribeSelectionChanges(() => undefined);
	const offB = svc.subscribeSelectionChanges(() => undefined);
	expect(on.mock.calls.map(([name]) => name)).toEqual([
		"active-leaf-change",
		"file-open",
	]);
	offA();
	expect(offref).not.toHaveBeenCalled();
	offB();
	expect(offref.mock.calls.map(([ref]) => ref)).toEqual(refs);
});
