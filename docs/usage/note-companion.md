# Note Companion

Note Companion is part of this fork's development source. The plugin manifest is still `0.13.2`; that number does not identify a Note Companion release. Upstream Community Plugins and BRAT installation instructions do not install this fork's changes.

## Start with a passage

1. Open a Markdown note in an editable view and select a passage. Open an Agent Client chat and expand **Note companion** above the composer. Use **Add selection**, or run **Agent Client: Add selection to note companion** from the command palette.
2. The composer shows a chip for each source the next send carries. The active note appears as one dashed **following** chip; × removes it for this conversation and ○ pins it as a session source. Drag notes onto the composer to mention them, onto **Note tools** to stage them, or use **+ Context** for mentions and **Note tools** (selection, headings, folders). Type a question and choose **Send**. A send whose sources are all visible as chips goes straight out. If the payload carries anything not shown in the composer — truncated text, a template or destination quote, a generated request, or a source without a chip — **Review outbound context** opens with the reasons, and **Send these blocks** sends exactly those bytes. **Review & send** opens the same review on demand; **Cancel** keeps working locally.
3. To keep part of the answer, choose **Use in note…** under that reply (it stays bound to that reply, not the latest one), then **Place a reply in a note**: choose a destination and preview the change. Literal placement makes no model request. To have the agent rewrite or integrate the answer, use **Editorial capture** and review its proposal.

## Build and preview a working set

| Control              | What it stages                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add selection**    | The exact editor selection, not the surrounding lines or the whole note.                                                                      |
| **Add heading**      | A heading and its section through the next heading of the same or higher level. Pick the numbered occurrence if headings repeat.              |
| **Add open note**    | A snapshot of an open Markdown note. You can also drag Markdown notes onto the tray or composer.                                              |
| **Pin working note** | A full-note snapshot of the active note as a session-pinned working item. Following the active note in the tray does not itself pin anything. |

Use full vault-relative paths to distinguish notes with the same basename. Use **Move up**, **Move down**, and **Remove** to manage the set. **Note tools** opens on demand and closes again; it changes the layout, not what is sent. **Note conversations** lists the conversations linked to the active note.

- **Working** materials are the main inputs; **Reference** materials are supporting inputs. Both can send text. **Destination only** does not attach the note body. **Choose destination** sets a placement target separately; it is not the same as adding the note as a source. A deliberate editorial request can include the destination section in its preview.
- **Pin to session** keeps an item available for later turns in the same conversation. **Use once** makes it next-turn context: the client consumes it when its inclusion in a completed turn is confirmed, not merely because you previewed or pressed Send.
- Before preview, the client checks whether a source changed or is missing. It does not silently replace the capture. Inspect it and decide whether to send it, remove it, or use **Refresh** on the note or heading. For a changed passage, select and capture it again in the editor. After a rename, check the path and scope before reuse.
- **Max note length** and **Max selection length** in Mentions settings bound the text included. The preview flags truncation in UTF-16 units. Rely on the text in the preview, not the size of the original note. Capture smaller passages for review if their full text will not fit.

The preview shows the prepared blocks used for dispatch, including other inputs that qualify for the turn, such as mentions, instructions and attachments. A staged source or destination is not implicitly reattached through ordinary mentions of the same path. An ordinary auto-mention can send the active note's path and an included selection; it is not a pinned snapshot. [Context files](/usage/context-files) are discovered by the agent itself, not added to the tray. Generated Companion requests use explicit inputs instead of automatically adding ordinary mentions.

::: warning Context is not an access restriction
Removing an item cannot take it out of earlier turns. Destination-only handling controls the prompt assembled by this client; it does not hide text you type, disable other attachments, or prevent agent tools from opening files. The agent and its provider apply their own access and retention rules. See [Editing and permissions](/usage/editing#permission-controls).
:::

Canceling the preview sends no prompt. A failed or uncertain turn is not automatically resent. Inspect the conversation and any tool effects before sending again; absent local confirmation does not prove the agent never received the request.

## Place a reply without rewriting it

1. In **Place a reply in a note**, use **Choose destination** for the end of an exact Markdown note or a specific heading occurrence. For **Insert** or **Replace**, put the caret or a nonempty selection in a source editor and use **Capture destination selection**. Save edits and recapture if the editor text no longer matches the saved note.
2. Choose the **Reply**. In **Optional excerpt: select text here**, highlight exactly what you want; **Use whole reply** resets the excerpt. **Append · preview** places the text at the end of the note or section. **Insert · preview** inserts at the captured start without removing text. **Replace · preview** substitutes the captured nonempty range. The reply is not rewritten; append adds surrounding line breaks where needed.
3. In **Review note change**, confirm the path and occurrence or offsets. Inspect the diff or expand **Exact before and after (JSON strings)** to check literal text and line endings. Choose **Apply this change** to write. Canceling does not modify the note.

### Receipts, conflicts, and undo

**Write receipts** records Companion note operations. A `verified` receipt means the plugin read the destination back and it matched the approved result. A `conflict` can mean the note or editor buffer no longer matches the reviewed text. Inspect the file, save or resolve edits, and make a fresh preview rather than forcing the old change. A range may need to be captured again after reopening.

For `pending`, `unknown`, or `undo-pending`, use **Reconcile without writing** before retrying. It compares current file content with the recorded before and after text; it can confirm the effect, report it was not applied or was undone, or report a conflict. It does not apply or revert anything. Unresolved operations block further Companion writes to that path. If the receipt itself could not be saved, inspect the note and resolve any storage warning before acting again.

**Undo…** → **Undo this write** is available for a verified edit to an existing note. It restores the recorded before text only if the note still matches the verified after text. Inspect and remove unwanted created notes manually; undo does not delete them. This receipt flow does not cover edits made by agent tools.

## Review annotated passages

Stage one or more selections, add an **Annotation** to each relevant passage, then choose **Review passages** and inspect the outbound blocks. The annotation guides the review; the proposal must identify a selected passage and quote its original text exactly. A response that fails request matching or contains an invalid, duplicate, or nonmatching revision does not produce write actions.

Use **Change and source** to inspect a proposal and **Review revision** to preview it against the destination. **Skip** dismisses a row without writing. Apply each change separately. Proposals do not merge: applying one edit invalidates other proposals based on the same old file, even for disjoint ranges. Do not apply overlapping revisions as a batch; recapture and request a fresh review after the first edit if another change is needed.

## Synthesize sources

Stage working or reference sources, choose **Synthesis**, **Agreements**, **Contradictions**, or **Evidence gaps**, and use **Bring these together**. Inspect the outbound context and send it. The request asks for exact vault links and source IDs and asks the agent to distinguish supported facts, uncertainty, and unsupported claims. **Synthesis · not fact-verified** is a reminder that those distinctions and citations are generated, not checked conclusions. The supplied-source controls open the mapped source or excerpt when available. If an excerpt moved or changed and cannot be located exactly, inspect the saved capture instead.

**Project actions** also offers **Brief me**, **Challenge this plan**, and **Where were we?**. Favourite actions can appear on the action strip. A recap is not a source of truth. These actions still go through outbound review.

## Turn a reply into an editorial proposal

In **Place a reply in a note** → **Editorial capture**, choose the reply or excerpt first:

- **Merge into section**, **Capture decision**, and **Close the loop** propose a replacement body for an exact destination heading. **Update the brief** in **Project actions** uses the same section merge. The prompt can include the selected reply, destination section, and staged source context. An oversized destination section is refused rather than replaced from a partial capture.
- **Save as note** proposes content for an explicit **New note vault path**, such as `Projects/Decision.md`. **Choose template** optionally includes a snapshot of an open Markdown template. Check the preview for the template's content and use an unused path in an existing folder. The action does not infer filing rules or overwrite an existing file.

Review the outbound blocks, then review the generated diff and path separately. An invalid or unrelated reply cannot create a proposal; a valid proposal still requires **Apply this change**. Generated prompts ask the agent not to use tools or edit files. That instruction does not enforce tool permissions.

## Continue a conversation

- **Connection details** separates the configured agent label from the adapter's runtime report. **Connected** confirms a usable ACP session, not a specific provider account, model or profile. **Needs approval** is an actual pending tool decision. **History only · not connected** can display saved text but cannot send prompts.
- From a sidebar chat, **Connection details** → **Move to editor tab** shows the same mounted conversation, including draft and active work, without starting a new agent process. Close the projection to return to the source pane. **Open new chat view** or **Open new floating chat view** opens an independent conversation. A second view cannot take over a conversation that already has a live owner; switch back to the owning view.
- **Reconnect** attempts to recover the same conversation, not create a new one under its name. Restore needs a compatible saved agent, working directory and ACP load or resume support. If the exact session cannot be restored, local history remains available without a connection; nothing is resent. Agent replay during restore is inbound history, not outgoing prompts or a queue of permission decisions. The client prefers its accepted local transcript when available rather than duplicating it with replay.
- With a note active, open **Note conversations** to find saved conversations associated with its exact path through staged sources, sent snapshots or a destination. Use **Open history only** to read locally, or **Resume with agent** when available. If resume fails, the picker falls back to local history. **New conversation with selected context** → **Stage checked context in a new chat (no send)** copies only checked source items into a distinct chat; it does not replay the old conversation or send automatically.
- Under **What changed?**, select a confirmed sent snapshot and compare its scope with the current note. A truncated snapshot compares only the transmitted prefix. When Obsidian renames a note, associations follow the new path, but the captured text and original sent path are preserved. Without a confirmed snapshot there is no send-backed comparison.

Text drafts, staged note context, sent snapshots and receipts are saved separately from the transcript in the vault's plugin data. If saving fails, use the displayed retry control and verify recovery before closing. Pasted images and ordinary file attachments are staged in memory; do not rely on them surviving a restart. Embedded chats have their own view ownership and restore rules; see [Embeddable Blocks](/usage/embeddable-blocks#persistence).

[Chat Export](/usage/chat-export) saves the conversation as Markdown, not the Companion sidecar, and does not guarantee redaction. Replies, tool output and attachments can still expose note content or paths. Review the export and any separate media before sharing, and consider who can access your vault backups or sync destination.
