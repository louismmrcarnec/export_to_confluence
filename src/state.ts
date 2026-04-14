export type FolderPagesRecord = Record<string, string>;

export type SaveFolderPages = (state: FolderPagesRecord) => Promise<void>;

export class FolderState {
  private pages: Map<string, string>;
  private save: SaveFolderPages;

  constructor(initial: FolderPagesRecord, save: SaveFolderPages) {
    this.pages = new Map(Object.entries(initial ?? {}));
    this.save = save;
  }

  getFolderPageId(path: string): string | undefined {
    return this.pages.get(path);
  }

  async setFolderPageId(path: string, pageId: string): Promise<void> {
    this.pages.set(path, pageId);
    await this.save(this.toJSON());
  }

  toJSON(): FolderPagesRecord {
    return Object.fromEntries(this.pages);
  }
}
