import { Platform, type App, type Plugin } from "obsidian";
import type { SwipeFolderNavSettings } from "./settings";

const DIRECTION_LOCK_THRESHOLD = 10;

// Lower-tier block threshold: once horizontal-dominant movement exceeds this,
// stopImmediatePropagation fires immediately, before the direction lock at 10px.
// This shrinks the window in which Obsidian's sidebar handler could commit its
// gesture. It alone never blocks native scrolling, so an intended vertical
// scroll still works normally inside this window.
const SIDEBAR_BLOCK_THRESHOLD = 4;

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

	private touchStart: { x: number; y: number } | null = null;
	private tracking: boolean = false;
	private direction: "horizontal" | "vertical" | null = null;
	private scrollableAncestor: HTMLElement | null = null;
	private listenersBound: boolean = false;
	private touchMoveBound: boolean = false;

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
		if (this.listenersBound) {
			return;
		}
		// Listeners stay bound for the plugin's lifetime; whether to act is
		// decided at touch time by isWithinActiveNote() (mode + container
		// guards). Binding on layout-change would read a stale mode — that
		// event fires before the mode switch completes — which is exactly the
		// race that used to leave the plugin permanently disabled.
		// window capture: top of the capture chain, ahead of document/element
		// listeners; capture-phase listeners on one node fire in registration
		// order and Obsidian core registered first, so nothing lower can run
		// after us here. touchend/touchcancel join touchstart on window so
		// they never depend on a container reference either.
		window.addEventListener("touchstart", this.onTouchStart, {
			passive: true,
			capture: true,
		});
		window.addEventListener("touchend", this.onTouchEnd, {
			passive: true,
			capture: true,
		});
		window.addEventListener("touchcancel", this.onTouchCancel, {
			passive: true,
			capture: true,
		});
		this.listenersBound = true;
	}

	detach(): void {
		if (!this.listenersBound) {
			return;
		}
		// removeEventListener must pass the same capture flag used at attach,
		// or the listeners never actually get removed.
		window.removeEventListener("touchstart", this.onTouchStart, true);
		window.removeEventListener("touchend", this.onTouchEnd, true);
		window.removeEventListener("touchcancel", this.onTouchCancel, true);
		// reset() also tears down the dynamically-bound touchmove.
		this.reset();
		this.listenersBound = false;
	}

	// ⑤ multi-touch: ignore the gesture if more than one finger is down
	private onTouchStart = (e: TouchEvent): void => {
		// window-level listener: must not touch events outside the active
		// note (sidebar, settings, command palette) or non-mobile / non-
		// reading-mode sessions.
		if (!this.isWithinActiveNote(e)) {
			return;
		}
		if (e.touches.length > 1) {
			this.reset();
			return;
		}
		const touch = e.touches[0];
		if (!touch) {
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
		// Bind the non-passive touchmove only while a gesture is actually
		// being tracked, so the browser never has to synchronously wait on us
		// for scrolls across the whole app. Still window-capture: that's what
		// keeps the sidebar interception ahead of Obsidian's handlers.
		if (!this.touchMoveBound) {
			window.addEventListener("touchmove", this.onTouchMove, {
				passive: false,
				capture: true,
			});
			this.touchMoveBound = true;
		}
		this.touchStart = { x: touch.clientX, y: touch.clientY };
		this.direction = null;
		this.tracking = true;
	};

	private onTouchMove = (e: TouchEvent): void => {
		// Same entry guard as touchstart: ignore events outside the note.
		if (!this.isWithinActiveNote(e)) {
			return;
		}
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

		// Tier 1 — 4px block: horizontal-dominant movement gets
		// stopImmediatePropagation immediately, before the direction lock,
		// denying Obsidian's sidebar handler the event. No preventDefault and
		// no direction lock here: it only cuts off other JS listeners, never
		// the browser's native scrolling, so an intended (diagonal/vertical)
		// scroll keeps working and we don't mis-take over gestures here.
		if (
			Math.max(Math.abs(dx), Math.abs(dy)) > SIDEBAR_BLOCK_THRESHOLD &&
			Math.abs(dx) > Math.abs(dy)
		) {
			e.stopImmediatePropagation();
		}

		// Tier 2 — direction lock: commit to horizontal/vertical once movement
		// exceeds the lock threshold, then stick with it for the gesture.
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
			// NOT stop other JS listeners. Obsidian's sidebar handler sits on
			// an ancestor and would receive the same events unless we cut them
			// off — stopImmediatePropagation() also suppresses later listeners
			// registered on this same node, which plain stopPropagation would
			// let through. Scope is safe: we're already limited to mobile
			// reading mode and the direction is locked horizontal.
			e.preventDefault();
			e.stopImmediatePropagation();
		}
		// Residual risk: the capture phase + 4px tier narrow the window but
		// cannot fully close the race with OS-level gestures.
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
		// The dynamically-bound touchmove only exists while tracking; tear it
		// down here so its non-passive cost never outlives the gesture.
		if (this.touchMoveBound) {
			window.removeEventListener("touchmove", this.onTouchMove, true);
			this.touchMoveBound = false;
		}
	}

	// ② text selection in progress
	private textSelectionActive(): boolean {
		const selection = window.getSelection();
		const container = this.resolveContainer();
		if (selection?.isCollapsed === false && container) {
			const anchor = selection.anchorNode;
			const focus = selection.focusNode;
			if (
				anchor &&
				focus &&
				container.contains(anchor) &&
				container.contains(focus)
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
		// Resolve live: the container is never cached, so the walk boundary
		// always reflects the current leaf even mid mode-switch.
		const container = this.resolveContainer();
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
		const container = this.resolveContainer();
		if (container && el.clientWidth >= container.clientWidth - 8) {
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

	// Entry guard for the document-level listeners: never act on touches
	// outside the current note's content area, and never outside mobile
	// reading mode. sidebar / settings / command palette touches fall through.
	private isWithinActiveNote(e: TouchEvent): boolean {
		if (!this.enabledInCurrentMode()) {
			return false;
		}
		const container = this.resolveContainer();
		if (!container) {
			return false;
		}
		const target = e.target instanceof Node ? e.target : null;
		if (!target || !container.contains(target)) {
			return false;
		}
		return true;
	}

	private resolveContainer(): HTMLElement | null {
		return (
			this.host.app.workspace.getMostRecentLeaf()?.view?.containerEl ?? null
		);
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
