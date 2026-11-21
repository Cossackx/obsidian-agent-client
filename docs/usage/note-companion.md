# Note Companion

Note Companion is part of this fork's development source. The plugin manifest is still `0.13.2`; that number does not identify a Note Companion release. Upstream Community Plugins and BRAT installation instructions do not install this fork's changes.

## Start with a passage

1. Focus the intended chat, then select text in a Markdown editor. Open the editor context menu and choose **Ask XO about selection** or **Suggest edit to selection**. Both actions are available in the Obsidian command palette and can be assigned hotkeys. They capture the exact passage for that conversation without sending it. If the source or conversation changes during handoff, select the passage again rather than switching to another target.
2. **Ask XO about selection** adds a passage chip without changing the draft. **Suggest edit to selection** adds a marked chip and appends an editable request to any existing draft. Edit the request and choose **Send**, then review and approve the prepared blocks. A matching response shows a targeted diff on the originating reply. **Accept** applies the reviewed change; **Cancel** dismisses it without writing. Save the note and recapture if the selected text changed. Remove the edit chip to cancel the edit intent before sending a different kind of request; remove or revise the draft text separately.
3. For ordinary chat, drag vault Markdown notes onto the composer to stage next-turn snapshots. **+ Context → Add note…** opens note search in the composer; choose a result to stage a mention without sending or replacing the existing draft. Select a chip for its scope and status. Following normally adds only the active note’s path; with a selection it adds the selected excerpt as context. A followed selection never enables editing: edits come only from explicit actions (**Pin**, **Add selection**, **Ask XO about selection**, **Suggest edit to selection**), which capture the editor afresh and grant edit authority only when the editor’s whole document matches the saved note. While the note is still loading or has unsaved changes, the capture is added as read-only context and you can try again in a moment. Pin to keep a snapshot, or remove the chip to stop following for this conversation. Images and other supported files remain attachments.
4. **Send** dispatches an ordinary turn directly when its exact sources are represented. Unrepresented or changed sources, truncation, generated instructions, and template or destination excerpts require **Review outbound context**. **Review & send** opens the same review on demand. **Send these blocks** dispatches only the approved blocks; canceling sends nothing.

## Build and preview a working set

| Control              | What it stages                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add selection**    | The exact editor selection, not the surrounding lines or the whole note.                                                                      |
| **Add heading**      | A heading and its section through the next heading of the same or higher level. Pick the numbered occurrence if headings repeat.              |
| **Add open note**    | A snapshot of an open Markdown note. Dropping a vault Markdown note onto the composer also stages a snapshot. |
| **Pin working note** | A full-note snapshot of the active note as a session-pinned working item. Following the active note does not itself pin anything. |

Use full vault-relative paths to distinguish notes with the same basename. Use **Move up**, **Move down**, and **Remove** to manage the set in **Note tools**. Closing these tools does not change what is sent. To add a folder, use the folder action in **Note tools**; a folder dropped onto the composer is skipped, not read recursively.

- **Working** materials are the main inputs; **Reference** materials are supporting inputs. Both can send text. **Destination only** does not attach the note body. **Choose destination** sets a placement target separately; it is not the same as adding the note as a source. A deliberate editorial request can include the destination section in its preview.
- **Pin to session** keeps an item available for later turns in the same conversation. **Use once** makes it next-turn context: the client consumes it when its inclusion in a completed turn is confirmed, not merely because you previewed or pressed Send.
- Before preview, the client checks whether a source changed or is missing. It does not silently replace the capture. Inspect it and decide whether to send it, remove it, or use **Refresh** on the note or heading. For a changed passage, select and capture it again in the editor. After a rename, check the path and scope before reuse.
- **Max note length** and **Max selection length** in Mentions settings bound the text included. The preview flags truncation in UTF-16 units. Rely on the text in the preview, not the size of the original note. Capture smaller passages for review if their full text will not fit.

The preview shows the prepared blocks used for dispatch, including other inputs that qualify for the turn, such as mentions, instructions and attachments. A staged source or destination is not implicitly reattached through ordinary mentions of the same path. Review flags missing mention text, unverified followed selections and configured formatting instructions that the client adds to the turn. [Context files](/usage/context-files) discovered separately by the agent are not shown in the client preview. Generated Companion requests use explicit inputs instead of automatically adding ordinary mentions.

::: warning Context is not an access restriction
Removing an item cannot take it out of earlier turns. Destination-only handling controls the prompt assembled by this client; it does not hide text you type, disable other attachments, or prevent agent tools from opening files. The agent and its provider apply their own access and retention rules. See [Editing and permissions](/usage/editing#permission-controls).
:::

Canceling the preview sends no prompt. A failed or uncertain turn is not automatically resent. Inspect the conversation and any tool effects before sending again; absent local confirmation does not prove the agent never received the request.

## Place a reply without rewriting it

Use **Insert in note…** on the reply you want, then choose a note and location. A valid saved editor caret can be offered in the chooser; a nonempty selection is never replaced by this action. If the button already names a note or heading (**Append to…**), clicking it confirms that placement directly. Literal insertion makes no model request and preserves the reply text as written.

For an excerpt or deliberate range replacement, open **Note tools** → **Place a reply in a note**. Pick a reply and optionally select an excerpt, then choose a destination or capture the editor range. Use **Append · preview**, **Insert · preview**, or **Replace · preview** as appropriate. In **Review note change**, check the target and exact before/after text, then choose **Apply this change** to write.

### Receipts, conflicts, and undo

**Write receipts** records Companion note operations. A `verified` receipt means the plugin read the destination back and it matched the approved result. A `conflict` can mean the note or editor buffer no longer matches the reviewed text. Inspect the file, save or resolve edits, and make a fresh preview rather than forcing the old change. A range may need to be captured again after reopening.

For `pending`, `unknown`, or `undo-pending`, use **Reconcile without writing** before retrying. It compares current file content with the recorded before and after text; it can confirm the effect, report it was not applied or was undone, or report a conflict. It does not apply or revert anything. Unresolved operations block further Companion writes to that path. If the receipt itself could not be saved, inspect the note and resolve any storage warning before acting again.

**Undo…** → **Undo this write** is available for a verified edit to an existing note. It restores the recorded before text only if the note still matches the verified after text and the plugin can prove it is the same file that was written. Rebuilding a chat service within the same vault runtime preserves that file binding. After a plugin or app restart, older receipts do not establish file identity: neither a matching path, creation timestamp nor matching content is sufficient. Undo then refuses without changing the note, and reconciliation cannot certify that unbound target. Inspect the recorded before/after text and recover manually rather than forcing an old operation. Inspect and remove unwanted created notes manually; undo does not delete them. This receipt flow does not cover edits made by agent tools.

## Review annotated passages

Stage one or more selections, add an **Annotation** to each relevant passage, then choose **Review passages** and inspect the outbound blocks. The annotation guides the review; the proposal must identify a selected passage and quote its original text exactly. A response that fails request matching or contains an invalid, duplicate, or nonmatching revision does not produce write actions.

Review the diff and exact target on the reply itself. Closing **Note tools** after approving the outbound turn does not cancel the request or hide its reply diff. **Accept** applies that proposal; **Cancel** dismisses it without writing. Proposals do not merge: applying one edit invalidates other proposals based on the same old file, even for disjoint ranges. Recapture and request a fresh review after the first edit if another change is needed.

## Synthesize sources

Stage working or reference sources, choose **Synthesis**, **Agreements**, **Contradictions**, or **Evidence gaps**, and use **Bring these together**. Inspect the outbound context and send it. The request asks for exact vault links and source IDs and asks the agent to distinguish supported facts, uncertainty, and unsupported claims. **Synthesis · not fact-verified** is a reminder that those distinctions and citations are generated, not checked conclusions. The supplied-source controls open the mapped source or excerpt when available. If an excerpt moved or changed and cannot be located exactly, inspect the saved capture instead.

**Project actions** also offers **Brief me**, **Challenge this plan**, and **Where were we?**. Favourite actions can appear on the action strip. A recap is not a source of truth. These actions still go through outbound review.

## Turn a reply into an editorial proposal

In **Place a reply in a note** → **Editorial capture**, choose the reply or excerpt first:

- **Merge into section**, **Capture decision**, and **Close the loop** propose a replacement body for an exact destination heading. **Update the brief** in **Project actions** uses the same section merge. The prompt can include the selected reply, destination section, and staged source context. An oversized destination section is refused rather than replaced from a partial capture.
- **Save as note** proposes content for an explicit **New note vault path**, such as `Projects/Decision.md`. **Choose template** optionally includes a snapshot of an open Markdown template. Check the preview for the template's content and use an unused path in an existing folder. The action does not infer filing rules or overwrite an existing file.

Review the outbound blocks, then review the generated diff and path on the reply. An invalid or unrelated reply cannot create a proposal; a valid proposal still requires **Accept**. Generated prompts ask the agent not to use tools or edit files. That instruction does not enforce tool permissions.

## Continue a conversation

- **Connection details** separates the configured agent label from the adapter's runtime report. **Connected** confirms a usable ACP session, not a specific provider account, model or profile. **Needs approval** is an actual pending tool decision. **History only · not connected** can display saved text but cannot send prompts.
- From a sidebar chat, **Connection details** → **Move to editor tab** shows the same mounted conversation, including draft and active work, without starting a new agent process. Close the projection to return to the source pane. **Open new chat view** or **Open new floating chat view** opens an independent conversation. A second view cannot take over a conversation that already has a live owner; switch back to the owning view.
- **Reconnect** attempts to recover the same conversation, not create a new one under its name. Restore needs a compatible saved agent, working directory and ACP load or resume support. If the exact session cannot be restored, local history remains available without a connection; nothing is resent. Agent replay during restore is inbound history, not outgoing prompts or a queue of permission decisions. The client prefers its accepted local transcript when available rather than duplicating it with replay.
- With a note active, open **Note conversations** in the chat header to find saved conversations associated with its exact path through staged sources, sent snapshots or a destination. Use **Open history only** to read locally, or **Resume with agent** when available. If resume fails, the picker falls back to local history. **New conversation with selected context** → **Stage checked context in a new chat (no send)** copies only checked sources, not pending edit intent; it does not replay the old conversation or send automatically.
- Under **What changed?**, select a confirmed sent snapshot and compare its scope with the current note. A truncated snapshot compares only the transmitted prefix. When Obsidian renames a note, associations follow the new path, but the captured text and original sent path are preserved. Without a confirmed snapshot there is no send-backed comparison.

Text drafts, staged note context, sent snapshots and receipts are saved separately from the transcript in the vault's plugin data. If saving fails, use the displayed retry control and verify recovery before closing. Pasted images and ordinary file attachments are staged in memory; do not rely on them surviving a restart. Embedded chats have their own view ownership and restore rules; see [Embeddable Blocks](/usage/embeddable-blocks#persistence).

[Chat Export](/usage/chat-export) saves the conversation as Markdown, not the Companion sidecar, and does not guarantee redaction. Replies, tool output and attachments can still expose note content or paths. Review the export and any separate media before sharing, and consider who can access your vault backups or sync destination.
