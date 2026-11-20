# Note Companion

Open **Note companion** in an Agent Client conversation to collect notes and passages. Use **Add open note**, **Add heading**, or select text in a Markdown source editor and choose **Add selection**. You can also drag a Markdown note onto the tray or into the composer. Use exact vault paths to distinguish notes with the same name.

## Review what leaves Obsidian

Choose whether context is working material, a reference, or a destination only. **Pin to session** keeps it available; **Use once** removes it after a confirmed completed turn. Use **Preview next send** (or Send) to inspect the blocks. If a note has changed, refresh or deliberately send the displayed capture. Cancellation does not send anything. If completion is uncertain, inspect the conversation before sending again; the client does not automatically repeat a Companion turn.

Destination-only notes are not automatically attached. Removing an attachment cannot remove its content from earlier turns. The context preview is not an access sandbox for a separately configured agent.

## Place a reply

Choose an exact destination and heading occurrence, or capture a range from the editor. In **Place a reply in a note**, pick a reply or highlight an excerpt in the read-only field. Append, insert, and replace are literal: they make no model request. Read the diff and choose **Apply this change**. A stale preview refuses to overwrite the note. A verified receipt means the destination was read back and matched the proposal. If the effect is unknown, use **Reconcile without writing** before considering a new preview.

Undo for an existing note requires the exact recorded postimage. The client does not automatically delete created notes; review and remove those manually if needed.

## Review, synthesize, or capture

Annotate passages before **Review passages**. Inspect each proposed revision and apply or skip it separately. **Bring these together** requests synthesis from the supplied sources; links identify supplied notes, not proof that a generated conclusion is true. Editorial capture requests a proposal first. The model reply cannot apply the proposal. Review the destination and diff yourself. New-note creation refuses collisions. You can supply an open Markdown template and an explicit new path rather than relying on assumed vault filing rules.

## Keep working

**Note conversations** finds local conversation associations and compares submitted snapshots to the current note. **Connection details** separates configured label from the agent's runtime report. History alone cannot send messages. Use **Reconnect** to try to restore a session, or start a distinct conversation if the agent does not support it. **Move to editor tab** opens the same mounted conversation without starting another process; close that tab to return it to its source pane.

Drafts, snapshots, and write receipts are local to the plugin session area in this vault. They may contain note text, so handle vault sync and backups accordingly. Applying a note change does not widen ACP file capabilities.
