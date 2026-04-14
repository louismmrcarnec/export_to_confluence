# Confluence Export

An [Obsidian](https://obsidian.md) plugin that exports notes to [Confluence](https://www.atlassian.com/software/confluence) using the Confluence REST API and a personal API token.

## Features

- Export the current note to a Confluence page with a single command or ribbon button
- Export an entire folder recursively via the file-browser context menu
- Images embedded in your notes are uploaded as Confluence attachments and rendered using the native image macro
- Base64-encoded images (e.g. from pasted screenshots) are decoded, uploaded, and wired up automatically
- The `confluence_page_id` frontmatter key is written back to the note after the first export, so subsequent exports update the same page rather than creating duplicates
- Configurable default space key, parent page, and image width, all overridable per note via frontmatter

## Installation

### From the Obsidian community plugins list

1. Open Obsidian Settings, navigate to **Community plugins**, and disable Safe mode if prompted.
2. Click **Browse**, search for **Confluence Export**, and click **Install**.
3. Enable the plugin and configure it under Settings > Confluence Export.

### Manual installation

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/louismmrcarnec/export_to_confluence/releases/latest).
2. Copy both files into a new folder at `<vault>/.obsidian/plugins/obsidian-confluence-export/`.
3. Reload Obsidian and enable the plugin under Settings > Community plugins.

## Setup

Open Settings > Confluence Export and fill in:

| Setting | Description |
|---|---|
| Base URL | Your Confluence site URL, e.g. `https://yourcompany.atlassian.net` |
| Username / email | The Atlassian account email associated with your API token |
| API token | A personal API token created at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) |
| Default space key | Space where new pages are created, e.g. `DOCS` |
| Default parent page ID | Optional page ID to place new pages under |
| Image width (px) | Maximum display width for uploaded images (default: 800) |
| Overwrite existing pages | When enabled, exporting a note whose title already exists updates that page instead of failing (disabled by default) |

## Usage

### Export a single note

With a markdown note open:

- Run the command **Confluence Export: Export current note to Confluence** from the command palette.
- Or click the cloud icon in the ribbon.

After a successful export, the plugin writes the Confluence page ID back to the note's frontmatter as `confluence_page_id`. Re-exporting the same note will update the existing page.

### Export a folder

Right-click any folder in the file browser and choose **Export folder to Confluence**. The plugin walks the folder tree recursively, creating a Confluence page for each folder and exporting each note as a child page. A summary notice reports how many pages were created, updated, or failed.

## Frontmatter reference

All settings can be overridden on a per-note basis using frontmatter keys:

| Key | Type | Description |
|---|---|---|
| `confluence_page_id` | string | Written automatically after the first export. Reused for all subsequent updates. |
| `confluence_space_key` | string | Override the default space for this note. |
| `confluence_parent_id` | string | Override the default parent page for this note. |
| `confluence_title` | string | Override the page title (defaults to the note filename). |
| `confluence_image_width` | number | Override the image display width in pixels. |
| `confluence_overwrite` | boolean | Set to `true` to overwrite an existing page by title, even if the global toggle is off. |

Example:

```yaml
---
confluence_space_key: ENG
confluence_parent_id: "987654"
confluence_title: "Q2 Architecture Decision"
confluence_image_width: 1200
confluence_overwrite: true
---
```

## Development

```bash
# Install dependencies
npm install

# Build in watch mode
npm run dev

# Production build
npm run build

# Run tests
npm test
```

The compiled `main.js` is excluded from version control. Copy it along with `manifest.json` into your vault's plugin folder to test locally.

## License

MIT. See [LICENSE](LICENSE).
