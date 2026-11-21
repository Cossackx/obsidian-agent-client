import type { CompanionState } from "../types/note-companion";

export class CompanionMutationExpired extends Error {
	constructor() {
		super("Conversation changed before the context action completed.");
	}
}

export type MutationGuard = () => void;

export function assertMutation(owns: () => boolean): MutationGuard {
	return () => {
		if (!owns()) throw new CompanionMutationExpired();
	};
}

export type CompanionChange = ((old: CompanionState) => CompanionState) & {
	check?: MutationGuard;
};

/** Carry the same guard through wrapper transforms and the final write. */
export function guardCompanionChange(
	owns: () => boolean,
	change: CompanionChange,
): CompanionChange {
	const check = () => {
		assertMutation(owns)();
		change.check?.();
	};
	check();
	return Object.assign(
		(old: CompanionState) => {
			check();
			return change(old);
		},
		{ check },
	);
}

/** Shared by every surface staging context in one composer. Busy operations
 * are rejected rather than queued with possibly obsolete UI input. */
export class CompanionMutationGate {
	private active = false;
	get busy() {
		return this.active;
	}

	async run<T>(
		owns: () => boolean,
		work: (check: MutationGuard) => Promise<T>,
	): Promise<T> {
		const check = assertMutation(owns);
		check();
		if (this.active)
			throw new Error("Wait for the current context action to finish.");
		this.active = true;
		try {
			return await work(check);
		} finally {
			this.active = false;
		}
	}
}
