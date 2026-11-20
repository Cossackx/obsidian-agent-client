# Note Companion Verification

This note describes reviewed fork development source at commit `13bcf7cf9b94a3a25c365810fea020c1204f25a2`, not a tagged release, installed build, or upstream feature. The manifest still declares `0.13.2`. Documentation-only commits may follow without changing that reviewed implementation.

## Implementation boundaries

- Prompt preparation combines selected snapshots with applicable ordinary message inputs. The outbound modal reviews the prepared blocks used for ACP dispatch, rather than rereading notes after approval. A completed turn is required to record confirmed sent sources. Generated review, synthesis and capture replies must correlate to the current request.
- Literal placement never calls the agent. Generated proposals never invoke the local write service on their own. Local writes record intent before mutation, compare the exact saved preimage, and read the result back before reporting success. Reconciliation reads without writing. These guarantees do not cover edits made by agent tools.
- A displayed transcript is not a live connection. Restore reserves the conversation and uses the saved identity; it does not resubmit previous prompts. Captured replay is attached to the accepted owner, and existing local history takes precedence. The client does not present replayed tool history as new permission requests.

## What was checked

Independent review passed 339 source tests and 30 frozen external contract checks. The same reviewed candidate passed all 16 workflows in a separate synthetic Obsidian vault. Coverage included exact selection with Unicode and CRLF, outbound and export boundaries, source refresh and comparison, literal writes and undo, conflict and unknown-effect recovery, draft and conversation ownership, proposal review, synthesis, editorial capture, and ACP permissions.

The first app run flagged two cases. Independent follow-up and visible keyboard navigation resolved them on the same code. At corrected 2× reflow in a narrow sidebar, ordinary Tab and Shift+Tab reached both permission choices. Real ACP allow and deny requests produced the expected file outcomes; pointer Deny was verified. A small overlap at the lower edge of Deny did not hide its label or prevent use. Hidden-renderer animation-frame delay was a host/testing limitation, not evidence of a foreground permission failure. Raw Enter activation was not verified.

Test clients were stopped and the separate test vault was disabled, closed and unregistered. These checks do not establish compatibility with every adapter or platform, GitHub publication, or installation in a live vault.

## Verify changes in a disposable vault

Run `npm test`, `npm run build`, and `npm run docs:build` for their respective source, plugin and documentation checks. For UI checks, use synthetic notes with duplicate headings and a dedicated test agent. Cancel an outbound preview and confirm there was no prompt; send again with explicit approval and compare the sent scope. Preview a local change, edit the destination before applying, and verify that the old preview cannot overwrite it. For an actual ACP permission request with auto-allow disabled, inspect both choices and verify each decision against the resulting file state, not just the banner disappearing. Keep transcripts, snapshots and credentials from private vaults out of public reports.

See the [Note Companion guide](/usage/note-companion) and [ACP capability reference](/reference/acp-support).
