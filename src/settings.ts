export interface SwipeFolderNavSettings {
	/** Sort order of notes within a folder. */
	sortMode: "name" | "mtime" | "ctime";
	/** Reverse the sort order. */
	sortReverse: boolean;
	/** Wrap around from first to last (and vice versa) when reaching the edge. */
	wrapAround: boolean;
	/** Minimum horizontal swipe distance (px) to trigger navigation. */
	minSwipeDistance: number;
	/** Maximum vertical drift (px) allowed before the swipe is ignored. */
	maxVerticalDrift: number;
	/** Show a notice with the target note's name when switching. */
	showNotice: boolean;
	/** Scope for the desktop-only navigation commands. */
	desktopNavigationScope: "folder" | "vault";
	/** Follow the active File Explorer sort order for desktop commands. */
	desktopFollowFileExplorerSort: boolean;
}

export const DEFAULT_SETTINGS: SwipeFolderNavSettings = {
	sortMode: "name",
	sortReverse: false,
	wrapAround: false,
	minSwipeDistance: 80,
	maxVerticalDrift: 60,
	showNotice: false,
	desktopNavigationScope: "folder",
	desktopFollowFileExplorerSort: true,
};
