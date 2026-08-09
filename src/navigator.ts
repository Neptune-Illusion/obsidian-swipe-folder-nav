import { App, Notice, TFile } from "obsidian";
import { DEFAULT_SETTINGS, SwipeFolderNavSettings } from "./settings";

export interface FolderNavigatorPlugin {
	app: App;
	settings: SwipeFolderNavSettings;
}

/** Navigates markdown files which are direct children of the active file's folder. */
export class FolderNavigator {
	private readonly app: App;
	private readonly plugin: FolderNavigatorPlugin;
	private navigating: boolean = false;

	constructor(plugin: FolderNavigatorPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
	}

	private get settings(): SwipeFolderNavSettings {
		return this.plugin.settings ?? DEFAULT_SETTINGS;
	}

	detach(): void {
		// Reserved for future workspace event registrations.
	}

	/** Return sorted markdown siblings, excluding files in nested folders. */
	getSiblings(file: TFile): TFile[] {
		if (!file?.parent) return [];

		const siblings = file.parent.children.filter(
			(child): child is TFile =>
				"extension" in child && child.extension === "md"
		);
		const { sortMode, sortReverse } = this.settings;
		siblings.sort((left, right) => {
			let result: number;
			if (sortMode === "name") {
				result = left.basename.localeCompare(right.basename, undefined, {
					numeric: true,
				});
			} else {
				result = left.stat[sortMode] - right.stat[sortMode];
			}
			return sortReverse ? -result : result;
		});
		return siblings;
	}

	getNext(file?: TFile | null): TFile | null {
		return this.getRelative(file, 1, this.settings.wrapAround);
	}

	getPrev(file?: TFile | null): TFile | null {
		return this.getRelative(file, -1, this.settings.wrapAround);
	}

	private getRelative(
		file: TFile | null | undefined,
		offset: number,
		wrap = false
	): TFile | null {
		const current = file ?? this.app.workspace.getActiveFile();
		if (!current) return null;
		const siblings = this.getSiblings(current);
		const index = siblings.findIndex((candidate) => candidate.path === current.path);
		if (index < 0) return null;
		let targetIndex = index + offset;
		if (targetIndex < 0 || targetIndex >= siblings.length) {
			if (!wrap || siblings.length < 2) return null;
			targetIndex = targetIndex < 0 ? siblings.length - 1 : 0;
		}
		return siblings[targetIndex];
	}

	/** Open the adjacent note in the current leaf. Returns false when navigation is unavailable. */
	async openRelative(offset: number): Promise<boolean> {
		if (offset !== 1 && offset !== -1) return false;
		// B4: reject overlapping navigations from rapid successive swipes.
		if (this.navigating) return false;
		this.navigating = true;
		try {
			const current = this.app.workspace.getActiveFile();
			if (!current) return false;
			// A workspace can briefly retain a file object after an external deletion.
			// Do not navigate using that stale object or its old sibling list.
			const resolved = this.app.vault.getFileByPath(current.path);
			if (resolved === null) return false;
			const siblings = this.getSiblings(current);
			const index = siblings.findIndex((candidate) => candidate.path === current.path);
			if (index < 0) return false;

			let targetIndex = index + offset;
			if (targetIndex < 0 || targetIndex >= siblings.length) {
				if (!this.settings.wrapAround || siblings.length < 2) {
					if (this.settings.showNotice) {
						new Notice(offset < 0 ? "Already at the first note" : "Already at the last note");
					}
					return false;
				}
				targetIndex = targetIndex < 0 ? siblings.length - 1 : 0;
			}

			const leaf = this.app.workspace.getMostRecentLeaf();
			if (!leaf) return false;
			const target = siblings[targetIndex];
			// No explicit viewState: opening in the same leaf naturally keeps
			// the current mode and does a lightweight content swap instead of
			// a full view rebuild (the main source of the flicker).
			await leaf.openFile(target);
			if (this.settings.showNotice) new Notice(target.name);
			return true;
		} finally {
			this.navigating = false;
		}
	}
}

export default FolderNavigator;
