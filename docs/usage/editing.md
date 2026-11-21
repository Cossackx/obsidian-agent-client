# Editing

Agent Client allows AI agents to edit files in your vault and working directory.

[Note Companion](/usage/note-companion#place-a-reply-without-rewriting-it) has a separate local editing flow. **Insert in note…** places the text of that reply at a chosen destination without a model request. **Accept** on a proposed diff approves only that change; generating the proposal does not approve a write. The plugin checks the saved text before writing and reads it back before reporting success.

## How Editing Works

When you ask the agent to modify files:

1. The agent proposes changes
2. You see the proposed edits in the chat
3. The agent may request permission to apply changes
4. Changes are applied to your files

<p align="center">
  <img src="/images/editing.webp" alt="Editing files with agents" width="400" />
</p>

## Permission Controls

Some agents request permission before performing certain actions. When a permission request appears:

1. Review the proposed action
2. Select one of the available options provided by the agent

**Needs approval** indicates a real ACP tool request. Review the command, path, or diff when supplied. Use Tab or Shift+Tab to reach the choices in a narrow pane. **Approve active permission** and **Reject active permission** select the corresponding one-time option when available. These decisions are separate from provider sign-in, outbound preview and local edits.

::: tip
Permission options vary by agent. Some agents may not request permission at all and edit files directly.
:::

### Auto-Allow Permissions

In **Settings → Agent Client → Permissions → Auto-allow permissions**, the plugin automatically chooses `allow_once` when offered. Otherwise the request still needs a decision.

::: warning
Use with caution: automatically allowed requests do not get individual review. Composer chips and local note diffs do not restrict agent tool access. Agents may also act without requesting ACP permission.
:::

## Viewing Changes

The chat displays file changes with:

- **File path**: Which file was modified
- **Diff view**: What was added/removed (when available)
- **Status**: Success or failure of the operation

### Auto-Collapse Long Diffs

Large diffs can be automatically collapsed to keep the chat readable. This feature is **disabled by default**.

| Setting | Default | Description |
|---------|---------|-------------|
| **Auto-collapse long diffs** | Off | Enable automatic collapsing of large diffs |
| **Collapse threshold** | 10 lines | Diffs exceeding this line count are collapsed |

Configure these in **Settings → Agent Client → Display**.

Collapsed diffs can be expanded by clicking on them.

## Best Practices

1. **Use version control**: Keep your vault in Git before letting agents edit
2. **Review changes**: Check diffs before confirming major modifications
3. **Start small**: Test with minor edits before complex changes

## Undo Changes

For a Companion edit, use [Write receipts](/usage/note-companion#receipts-conflicts-and-undo). Reconcile a pending or unknown result before retrying. Agent tool edits do not generate Companion receipts.

If an agent makes unwanted changes:

- Use **Editor**: Cmd/Ctrl+Z in the affected file
- Use **Git**: `git checkout -- <file>` or `git restore <file>` (if your vault is version-controlled)
