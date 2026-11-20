export function deriveCompanionStatus(input: {
	connected: boolean;
	busy: boolean;
	pendingPermission: boolean;
	hasHistory: boolean;
	initializing: boolean;
	error?: string;
}) {
	if (input.pendingPermission) return "needs-approval";
	if (input.error) return "error";
	if (input.initializing) return "connecting";
	if (!input.connected)
		return input.hasHistory ? "history-only" : "disconnected";
	return input.busy ? "working" : "connected";
}

export const companionStatusLabel = {
	"needs-approval": "Needs approval",
	error: "Connection or turn error",
	connecting: "Connecting",
	"history-only": "History only · not connected",
	disconnected: "Disconnected",
	working: "Working",
	connected: "Connected",
} as const;
