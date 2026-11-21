import type { JSXElementConstructor, ReactElement } from "react";
import { TFile } from "obsidian";

/** Shared typed scaffolding for the composer lifecycle regression tests. */
export type TreeElement = ReactElement<Record<string, unknown>>;
export type ButtonProps = { onClick: () => unknown; children?: unknown };
export type MenuRow = {
	title?: string;
	click?: () => void;
	setTitle(this: MenuRow, title: string): MenuRow;
	onClick(this: MenuRow, click: () => void): MenuRow;
};

export function latch() {
	let go!: () => void;
	const p = new Promise<void>((r) => (go = r));
	return { p, go };
}

const isElement = (e: unknown): e is TreeElement =>
	typeof e === "object" && e !== null && !!(e as { props?: unknown }).props;

export function search(
	e: unknown,
	check: (e: TreeElement) => boolean,
): TreeElement | undefined {
	if (Array.isArray(e)) {
		for (const child of e as unknown[]) {
			const hit = search(child, check);
			if (hit) return hit;
		}
	} else if (isElement(e)) {
		if (check(e)) return e;
		return search(e.props.children, check);
	}
	return undefined;
}

/** Element of a component type; its props are that component's props. */
export function find<P>(
	tree: unknown,
	type: JSXElementConstructor<P>,
): ReactElement<P> | undefined {
	return search(tree, (e) => e.type === type) as ReactElement<P> | undefined;
}

export function propsOf<P>(tree: unknown, type: JSXElementConstructor<P>): P {
	const hit = find(tree, type);
	if (!hit) throw Error(`missing ${type.name} element`);
	return hit.props;
}

export const findBtn = (tree: unknown, label: string) =>
	search(tree, (x) => x.type === "button" && x.props.children === label)
		?.props as ButtonProps | undefined;

export const fakeFile = (path: string, size = 10) =>
	Object.assign(new TFile(path, path.split(".")[0]), {
		name: path,
		stat: { mtime: 0, size },
	});
