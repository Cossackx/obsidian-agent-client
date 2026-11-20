import { useCallback, useLayoutEffect, useRef } from "react";
import type { ChatViewRegistry } from "../services/view-registry";

/** Hold the target across preparation, identity publication, and the restore RPC. */
export function useRestoreOwner(
	registry: ChatViewRegistry,
	viewId: string,
	beforeRestore: () => Promise<() => void>,
) {
	const lifetime = useRef<object | null>(null);
	useLayoutEffect(() => {
		lifetime.current = {};
		return () => {
			lifetime.current = null;
		};
	}, [registry, viewId]);
	return useCallback(
		async <T>(
			id: string,
			run: (active: () => boolean) => Promise<T>,
		): Promise<T> => {
			const owner = lifetime.current;
			const active = () => owner !== null && lifetime.current === owner;
			if (!active())
				throw new Error("The owner view closed before restoring.");
			const release = registry.reserveRestore(id, viewId);
			let finish: (() => void) | undefined;
			try {
				finish = await beforeRestore();
				if (!active())
					throw new Error("The owner view closed before restoring.");
				return await run(active);
			} finally {
				finish?.();
				release();
			}
		},
		[registry, viewId, beforeRestore],
	);
}
