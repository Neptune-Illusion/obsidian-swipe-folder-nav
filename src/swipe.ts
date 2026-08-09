import { Platform, type App, type Plugin } from "obsidian";
import type { SwipeFolderNavSettings } from "./settings";

const DIRECTION_LOCK_THRESHOLD = 10;

// Obsidian page-level scroll containers must never be treated as local
// horizontal scroll regions (their scrollWidth > clientWidth once any
// content — e.g. a wide LaTeX formula — overflows the viewport).
const PAGE_LEVEL_SCROLL_CLASSES = [
	"markdown-preview-view",
	"markdown-preview-sizer",
	"markdown-reading-view",
	"view-content",
	"workspace-leaf-content",
];

export type SwipeDirection = "left" | "right";

export interface SwipeControllerHost {
	app: App;
	settings: SwipeFolderNavSettings;
	registerEvent: Plugin["registerEvent"];
}

export class SwipeController {
	private host: SwipeControllerHost;
	private onSwipe: (direction: SwipeDirection) => void;

	private containerEl: HTMLElement | null = null;
	private touchStart: { x: number; y: number } | null = null;
	private tracking: boolean = false;
	private direction: "horizontal" | "vertical" | null = null;
	private scrollableAncestor: HTMLElement | null = null;

	constructor(
		host: SwipeControllerHost,
		onSwipe: (direction: SwipeDirection) => void
	) {
		this.host = host;
		this.onSwipe = onSwipe;
		host.registerEvent(
			host.app.workspace.on("active-leaf-change", () => this.attach())
		);
		// Mode toggles (reading/edit) on the same leaf don't fire
		// active-leaf-change, so re-attach on layout-change too.
		host.registerEvent(
			host.app.workspace.on("layout-change", () => this.attach())
		);
		this.attach();
	}

	attach(): void {
		const container = this.host.app.workspace.getMostRecentLeaf()?.view?.containerEl;
		// Dedup: same container + mode still enabled → nothing to rebind.
		// openFile fires both active-leaf-change and layout-change on every
		// page turn; skipping the redundant detach/rebind avoids churn.
		if (container === this.containerEl && this.enabledInCurrentMode()) {
			return;
		}
		this.detach();
		if (!container || !this.enabledInCurrentMode()) {
			return;
		}
		this.containerEl = container;
		container.addEventListener("touchstart", this.onTouchStart, {
			passive: true,
		});
		// touchmove must be non-passive so we can preventDefault once the
		// gesture is locked as horizontal (blocks Obsidian's sidebar handler).
		container.addEventListener("touchmove", this.onTouchMove, {
			passive: false,
		});
		container.addEventListener("touchend", this.onTouchEnd, {
			passive: true,
		});
		container.addEventListener("touchcancel", this.onTouchCancel, {
			passive: true,
		});
	}

	detach(): void {
		const container = this.containerEl;
		this.containerEl = null;
		this.reset();
		if (!container) {
			return;
		}
		container.removeEventListener("touchstart", this.onTouchStart);
		container.removeEventListener("touchmove", this.onTouchMove);
		container.removeEventListener("touchend", this.onTouchEnd);
		container.removeEventListener("touchcancel", this.onTouchCancel);
	}

	// ⑤ multi-touch: ignore the gesture if more than one finger is down
	private onTouchStart = (e: TouchEvent): void => {
		if (e.touches.length > 1) {
			this.reset();
			return;
		}
		const touch = e.touches[0];
		if (!touch) {
			this.reset();
			return;
		}
		// ① screen edge: near left/right edge of the screen, don't take over
		if (this.nearScreenEdge(touch.clientX)) {
			this.reset();
			return;
		}
		// ② text selection active
		if (this.textSelectionActive()) {
			this.reset();
			return;
		}
		// ③ record the nearest local horizontal scroll region (code blocks,
		// tables, wide formulas) under the finger, if any. Page-level scroll
		// containers are excluded, so a wide formula on the page no longer
		// kills swiping for the whole note. We still track the gesture; the
		// scrollable region only yields to native scrolling in touchmove.
		this.scrollableAncestor = this.findScrollableAncestor(e.target);
		this.touchStart = { x: touch.clientX, y: touch.clientY };
		this.direction = null;
		this.tracking = true;
	};

	private onTouchMove = (e: TouchEvent): void => {
		if (!this.tracking || !this.touchStart) {
			return;
		}
		// ⑤ a second finger joined mid-gesture: abort immediately
		if (e.touches.length > 1) {
			this.reset();
			return;
		}
		// ② selection may have started mid-gesture
		if (this.textSelectionActive()) {
			this.reset();
			return;
		}
		const touch = e.touches[0];
		if (!touch) {
			return;
		}
		const dx = touch.clientX - this.touchStart.x;
		const dy = touch.clientY - this.touchStart.y;

		// Direction lock: commit to horizontal/vertical once movement exceeds
		// the lock threshold, then stick with it for the rest of the gesture.
		if (this.direction === null) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) <= DIRECTION_LOCK_THRESHOLD) {
				return;
			}
			if (Math.abs(dx) > Math.abs(dy)) {
				this.direction = "horizontal";
			} else {
				// Vertical scroll: hand back to native scrolling entirely.
				this.direction = "vertical";
				this.reset();
				return;
			}
		}

		if (this.direction === "horizontal") {
			// Direction-aware yield: if the finger is on a local horizontal
			// scroll region (formula/code/table) that still has room in the
			// swipe direction, hand this gesture to native scrolling instead
			// of paging. Once the region is scrolled to its boundary, the
			// next swipe pages normally — the region is never a dead zone.
			if (
				this.scrollableAncestor &&
				this.canStillScroll(this.scrollableAncestor, dx)
			) {
				this.reset();
				return;
			}
			// preventDefault() only stops the browser's default action; it does
			// NOT stop other JS listeners. Obsidian's sidebar handler sits on an
			// ancestor (e.g. .app-container / document) and receives the same
			// bubbling events unless we cut the bubble off — so stopPropagation()
			// is required to actually block it. Scope is safe: we're already
			// limited to mobile reading mode and the direction is locked
			// horizontal, i.e. a gesture we explicitly claim.
			e.preventDefault();
			e.stopPropagation();
		}
		// Known residual risk: direction locking only kicks in once the finger
		// has moved past DIRECTION_LOCK_THRESHOLD (10px). Inside that window we
		// block nothing, so if Obsidian commits its sidebar gesture within the
		// first 10px we cannot stop it. 10px is a deliberate tradeoff — smaller
		// misreads slight finger jitter as horizontal, larger leaves a wider
		// window for the native gesture. If real-device testing still shows the
		// sidebar opening, fall back to capturing touch events on the ancestor
		// in the capture phase (more aggressive; not implemented yet).
	};

	private onTouchEnd = (e: TouchEvent): void => {
		if (
			!this.tracking ||
			!this.touchStart ||
			this.direction !== "horizontal"
		) {
			this.reset();
			return;
		}
		const touch = e.changedTouches[0];
		if (touch) {
			const s = this.host.settings;
			const dx = touch.clientX - this.touchStart.x;
			const dy = touch.clientY - this.touchStart.y;
			const adx = Math.abs(dx);
			const ady = Math.abs(dy);
			if (
				adx >= s.minSwipeDistance &&
				ady <= s.maxVerticalDrift &&
				adx >= 2 * ady
			) {
				this.onSwipe(dx < 0 ? "left" : "right");
			}
		}
		this.reset();
	};

	private onTouchCancel = (): void => {
		this.reset();
	};

	private reset(): void {
		this.tracking = false;
		this.touchStart = null;
		this.direction = null;
		this.scrollableAncestor = null;
	}

	// ① screen edge heuristic (Obsidian native sidebar gestures live here)
	private nearScreenEdge(clientX: number): boolean {
		return clientX < 25 || clientX > window.innerWidth - 25;
	}

	// ② text selection in progress
	private textSelectionActive(): boolean {
		const selection = window.getSelection();
		if (selection?.isCollapsed === false && this.containerEl) {
			const anchor = selection.anchorNode;
			const focus = selection.focusNode;
			if (
				anchor &&
				focus &&
				this.containerEl.contains(anchor) &&
				this.containerEl.contains(focus)
			) {
				return true;
			}
		}
		const view = this.host.app.workspace.getMostRecentLeaf()?.view as {
			editor?: { getSelection?: () => string };
		} | null;
		const sel = view?.editor?.getSelection?.();
		return typeof sel === "string" && sel.length > 0;
	}

	// ③ find the nearest LOCAL horizontal scroll region under the finger,
	// excluding containerEl itself and Obsidian page-level scroll containers.
	private findScrollableAncestor(target: EventTarget | null): HTMLElement | null {
		const container = this.containerEl;
		if (!container) {
			return null;
		}
		let el = target instanceof Element ? target : null;
		while (el && el !== container) {
			if (this.isPageLevelScrollContainer(el)) {
				el = el.parentElement;
				continue;
			}
			if (el.scrollWidth > el.clientWidth + 1) {
				const ox = window.getComputedStyle(el).overflowX;
				if (ox === "auto" || ox === "scroll" || ox === "overlay") {
					return el as HTMLElement;
				}
			}
			el = el.parentElement;
		}
		return null;
	}

	// Page-level containers never count as local scroll regions: either an
	// Obsidian class or an element as wide as the note container (covers
	// theme-custom class names via the size fallback).
	private isPageLevelScrollContainer(el: Element): boolean {
		if (
			this.containerEl &&
			el.clientWidth >= this.containerEl.clientWidth - 8
		) {
			return true;
		}
		return PAGE_LEVEL_SCROLL_CLASSES.some((cls) => el.classList.contains(cls));
	}

	// Whether el still has content to scroll towards in the swipe direction.
	// dx < 0 (finger moves left) reveals content to the right; dx > 0 reveals
	// content to the left.
	private canStillScroll(el: HTMLElement, dx: number): boolean {
		if (dx < 0) {
			return el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
		}
		return el.scrollLeft > 1;
	}

	// Active only on mobile, in a markdown view in reading (preview) mode.
	// Only MarkdownView exposes getMode(); other view types fail the check.
	private enabledInCurrentMode(): boolean {
		if (!Platform.isMobile) {
			return false;
		}
		const view = this.host.app.workspace.getMostRecentLeaf()?.view as {
			getMode?: () => string;
		} | null;
		return (
			typeof view?.getMode === "function" && view.getMode() === "preview"
		);
	}
}
