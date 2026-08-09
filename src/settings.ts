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
	/** Whether swiping in edit mode is enabled. When false, only reading mode works. */
	enableInEditMode: boolean;
	/** Show a notice with the target note's name when switching. */
	showNotice: boolean;
}

export const DEFAULT_SETTINGS: SwipeFolderNavSettings = {
	sortMode: "name",
	sortReverse: false,
	wrapAround: false,
	minSwipeDistance: 80,
	maxVerticalDrift: 60,
	enableInEditMode: true,
	showNotice: true,
};
