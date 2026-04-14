import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
} from "obsidian";
import { ConfluenceClient } from "./src/confluence";
import { exportNote } from "./src/export";
import { exportFolder } from "./src/bulk";
import { FolderState } from "./src/state";
import { stringOr, numberOr, booleanOr } from "./src/helpers";

interface ConfluenceExportSettings {
  baseUrl: string;
  username: string;
  apiToken: string;
  defaultSpaceKey: string;
  defaultParentPageId: string;
  imageWidth: number;
  overwriteExistingPage: boolean;
}

const DEFAULT_SETTINGS: ConfluenceExportSettings = {
  baseUrl: "",
  username: "",
  apiToken: "",
  defaultSpaceKey: "",
  defaultParentPageId: "",
  imageWidth: 800,
  overwriteExistingPage: false,
};

// Frontmatter keys read/written by the plugin.
const FM_PAGE_ID = "confluence_page_id";
const FM_SPACE_KEY = "confluence_space_key";
const FM_PARENT_ID = "confluence_parent_id";
const FM_TITLE = "confluence_title";
const FM_IMAGE_WIDTH = "confluence_image_width";
const FM_OVERWRITE = "confluence_overwrite";

interface PluginData {
  settings: ConfluenceExportSettings;
  folderPages: Record<string, string>;
}

export default class ConfluenceExportPlugin extends Plugin {
  settings: ConfluenceExportSettings = DEFAULT_SETTINGS;
  folderState!: FolderState;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "export-current-note-to-confluence",
      name: "Export current note to Confluence",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.runNoteExport(file);
        return true;
      },
    });

    this.addCommand({
      id: "export-folder-to-confluence",
      name: "Export folder to Confluence",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const folder = file?.parent;
        if (!folder) return false;
        if (!checking) this.runFolderExport(folder);
        return true;
      },
    });

    this.addRibbonIcon("cloud", "Export current note to Confluence", () => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") {
        new Notice("No active markdown note to export.");
        return;
      }
      this.runNoteExport(file);
    });

    this.addSettingTab(new ConfluenceExportSettingTab(this.app, this));

    // Register folder context-menu item
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, abstractFile) => {
        if (!(abstractFile instanceof TFolder)) return;
        menu.addItem((item) => {
          item
            .setTitle("Export folder to Confluence")
            .setIcon("cloud")
            .onClick(() => this.runFolderExport(abstractFile));
        });
      }),
    );
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<PluginData> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? data);
    this.folderState = new FolderState(
      data?.folderPages ?? {},
      (fp) => this.saveFolderPages(fp),
    );
  }

  async saveSettings() {
    const data = (await this.loadData()) as Partial<PluginData> | null ?? {};
    await this.saveData({ ...data, settings: this.settings });
  }

  private async saveFolderPages(folderPages: Record<string, string>): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginData> | null ?? {};
    await this.saveData({ ...data, folderPages });
  }

  private runNoteExport(file: TFile): void {
    this.exportCurrentNote(file).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Confluence export failed", err);
      new Notice(`Confluence export failed: ${message}`);
    });
  }

  private runFolderExport(folder: TFolder): void {
    this.exportCurrentFolder(folder).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Confluence folder export failed", err);
      new Notice(`Confluence folder export failed: ${message}`);
    });
  }

  // ---- single-note export -------------------------------------------------

  async exportCurrentNote(file: TFile): Promise<void> {
    this.validateSettings();

    const cache = this.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;

    const title = stringOr(fm[FM_TITLE], file.basename);
    const spaceKey = stringOr(fm[FM_SPACE_KEY], this.settings.defaultSpaceKey);
    const parentId = stringOr(fm[FM_PARENT_ID], this.settings.defaultParentPageId);
    const existingPageId = stringOr(fm[FM_PAGE_ID], "");
    const imageWidth = numberOr(fm[FM_IMAGE_WIDTH], this.settings.imageWidth);
    const overwriteExisting =
      this.settings.overwriteExistingPage || booleanOr(fm[FM_OVERWRITE], false);

    if (!spaceKey) {
      throw new Error(
        "Missing Confluence space key. Set a default in the plugin settings " +
          "or add `confluence_space_key:` to the note frontmatter.",
      );
    }

    new Notice(`Exporting "${title}" to Confluence…`);

    const client = this.makeClient();
    const { pageId, warnings } = await exportNote({
      file,
      app: this.app,
      client,
      existingPageId,
      title,
      spaceKey,
      parentId,
      imageWidth,
      overwriteExisting,
    });

    await this.writePageIdToFrontmatter(file, pageId);

    if (warnings.length > 0) {
      new Notice(
        `Confluence export succeeded (page ${pageId}) with ${warnings.length} warning(s).`,
      );
    } else {
      new Notice(`Confluence export succeeded (page ${pageId}).`);
    }
  }

  // ---- folder export -------------------------------------------------------

  async exportCurrentFolder(folder: TFolder): Promise<void> {
    this.validateSettings();

    new Notice(`Exporting folder "${folder.name}" to Confluence…`);
    const client = this.makeClient();

    const result = await exportFolder({
      folder,
      app: this.app,
      client,
      state: this.folderState,
      settings: {
        defaultSpaceKey: this.settings.defaultSpaceKey,
        defaultParentPageId: this.settings.defaultParentPageId,
        overwriteExistingPage: this.settings.overwriteExistingPage,
        defaultImageWidth: this.settings.imageWidth,
      },
    });

    new Notice(
      `Folder export done: ${result.created} created, ${result.updated} updated, ${result.failed} failed.`,
    );
  }

  // ---- helpers -------------------------------------------------------------

  private makeClient(): ConfluenceClient {
    return new ConfluenceClient({
      baseUrl: this.apiBase(),
      authHeader: this.authHeader(),
    });
  }

  private validateSettings(): void {
    if (!this.settings.baseUrl) throw new Error("Confluence base URL is not set.");
    if (!this.settings.username) throw new Error("Confluence username / email is not set.");
    if (!this.settings.apiToken) throw new Error("Confluence API token is not set.");
  }

  private authHeader(): string {
    return "Basic " + btoa(`${this.settings.username}:${this.settings.apiToken}`);
  }

  private apiBase(): string {
    let trimmed = this.settings.baseUrl.trim().replace(/\/+$/, "");
    if (/\/wiki\/rest\/api$/.test(trimmed)) return trimmed;
    if (/\/wiki$/.test(trimmed)) return trimmed + "/rest/api";
    return trimmed + "/wiki/rest/api";
  }

  private async writePageIdToFrontmatter(file: TFile, pageId: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[FM_PAGE_ID] = String(pageId);
    });
  }
}

// ---- settings tab ----------------------------------------------------------

class ConfluenceExportSettingTab extends PluginSettingTab {
  plugin: ConfluenceExportPlugin;

  constructor(app: App, plugin: ConfluenceExportPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("Confluence base URL, e.g. https://yourcompany.atlassian.net")
      .addText((text) =>
        text
          .setPlaceholder("https://yourcompany.atlassian.net")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Username / email")
      .setDesc("Atlassian account email used for API authentication.")
      .addText((text) =>
        text
          .setPlaceholder("you@example.com")
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API token")
      .setDesc(
        "Personal Confluence API token. Create one at " +
          "https://id.atlassian.com/manage-profile/security/api-tokens",
      )
      .addText((text) => {
        text
          .setPlaceholder("API token")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Default space key")
      .setDesc(
        "Space key used when the note does not define `confluence_space_key` in its frontmatter.",
      )
      .addText((text) =>
        text
          .setPlaceholder("DOCS")
          .setValue(this.plugin.settings.defaultSpaceKey)
          .onChange(async (value) => {
            this.plugin.settings.defaultSpaceKey = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default parent page ID")
      .setDesc(
        "Optional parent page placed above newly-created pages when the note does not " +
          "define `confluence_parent_id` in its frontmatter.",
      )
      .addText((text) =>
        text
          .setPlaceholder("123456")
          .setValue(this.plugin.settings.defaultParentPageId)
          .onChange(async (value) => {
            this.plugin.settings.defaultParentPageId = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Image width (px)")
      .setDesc(
        "Maximum display width for embedded images. Override per note with " +
          "`confluence_image_width:` in frontmatter.",
      )
      .addText((text) =>
        text
          .setPlaceholder("800")
          .setValue(String(this.plugin.settings.imageWidth))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.imageWidth = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Overwrite existing pages")
      .setDesc(
        "When enabled, exporting a note whose title already exists in Confluence will update " +
          "that page instead of failing. Disabled by default to prevent accidental overwrites.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.overwriteExistingPage)
          .onChange(async (value) => {
            this.plugin.settings.overwriteExistingPage = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Per-note frontmatter overrides").setHeading();
    const list = containerEl.createEl("ul");
    list.createEl("li", {
      text: "confluence_page_id — auto-written after the first export; reused for updates.",
    });
    list.createEl("li", { text: "confluence_space_key — override the default space." });
    list.createEl("li", {
      text: "confluence_parent_id — override the default parent page.",
    });
    list.createEl("li", {
      text: "confluence_title — override the page title (defaults to the note name).",
    });
    list.createEl("li", {
      text: "confluence_image_width — override the image width in pixels (defaults to the plugin setting).",
    });
    list.createEl("li", {
      text: "confluence_overwrite — set to true to overwrite an existing page by title, even if the global toggle is off.",
    });
  }
}
