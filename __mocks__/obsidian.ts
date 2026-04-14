import { vi } from "vitest";

// Minimal stubs for the `obsidian` module surface used by this plugin's
// source files. Tests inject behavior by reassigning `requestUrl.mockResolvedValue(...)`
// or by constructing TFile/TFolder instances directly.

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export const requestUrl = vi.fn<[RequestUrlParam], Promise<RequestUrlResponse>>();

export class TAbstractFile {
  path = "";
  name = "";
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  extension = "md";
  basename = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.parent === null;
  }
}

export class Notice {
  constructor(public message: string, public timeout?: number) {}
}

export class Plugin {
  app: unknown;
  manifest: unknown;
  constructor(app: unknown, manifest: unknown) {
    this.app = app;
    this.manifest = manifest;
  }
  addCommand(_: unknown): void {}
  addRibbonIcon(_a: string, _b: string, _c: () => void): HTMLElement {
    return {} as HTMLElement;
  }
  addSettingTab(_: unknown): void {}
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(_: unknown): Promise<void> {}
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl: HTMLElement = {} as HTMLElement;
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
  display(): void {}
  hide(): void {}
}

export class Setting {
  constructor(_: unknown) {}
  setName(_: string): this { return this; }
  setDesc(_: string): this { return this; }
  addText(_: (t: unknown) => void): this { return this; }
}

export interface App {
  vault: unknown;
  workspace: unknown;
  metadataCache: unknown;
  fileManager: unknown;
}
