# Multi-Session Chat

Run multiple independent agent conversations simultaneously.

<p align="center">
  <img src="/images/multi-session.webp" alt="Multiple chat views running simultaneously" />
</p>

## Overview

Agent Client supports opening multiple chat views, each with its own:
- Independent agent process
- Separate session and message history
- Individual agent selection

::: tip
This is useful when you want to work with different agents side-by-side, or run parallel conversations for different tasks.
:::

## Opening Multiple Views

### Via Command Palette

1. Open command palette (`Cmd/Ctrl + P`)
2. Search for **"Open new chat view"**
3. A new chat view opens in your configured location

In the fork build, **Connection details** → **Move to editor tab** in a sidebar chat relocates the same mounted conversation; closing that tab returns it to the source pane. This does not create a second process, draft or permission queue. Use **Open new chat view** for an independent conversation. See [Note Companion](/usage/note-companion#continue-a-conversation).

### Via Header Menu

1. Click the **⋮** (ellipsis) menu in the chat header
2. Select **"Open new view"**

## Chat View Location

Configure where new chat views open in **Settings → Agent Client → Display → Chat view location**:

| Location | Description |
|----------|-------------|
| **Right pane (tabs)** (default) | Opens in the right sidebar |
| **Editor area (tabs)** | Opens as a tab in the editor area |
| **Editor area (split)** | Opens in a new split pane |

## Broadcast Commands

Control multiple chat views at once from the command palette:

| Command | Description |
|---------|-------------|
| **Broadcast prompt** | Copy the active view's input text and images to all other views |
| **Broadcast send** | Send messages in all views simultaneously |
| **Broadcast cancel** | Cancel ongoing operations in all views |

::: tip
Broadcast commands are useful for comparing how different agents respond to the same prompt.

In the fork build, review outbound blocks for each send. Broadcast prompt copies composer input, not another conversation's Companion working set. Each target view uses its own context and session.
:::

## Focus Navigation

Quickly switch between chat views:

| Command | Description |
|---------|-------------|
| **Focus next chat view** | Move focus to the next chat view |
| **Focus previous chat view** | Move focus to the previous chat view |

::: tip
Assign keyboard shortcuts to these commands in **Settings → Hotkeys** for faster navigation.
:::
