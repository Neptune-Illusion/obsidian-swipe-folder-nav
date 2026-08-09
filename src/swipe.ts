import { Platform, type App, type Plugin } from "obsidian";
import type { SwipeFolderNavSettings } from "./settings";

const DIRECTION_LOCK_THRESHOLD = 10;

// Lower-tier block threshold: once horizontal-dominant movement exceeds this,
// stopImmediatePropagation fires immediately, before the direction lock at 10px.
// This shrinks the window in which Obsidian's sidebar handler could commit its
// gesture. It alone never blocks native scrolling, so an intended vertical
// scroll still works normally inside this window.
const SIDEBAR_BLOCK_THRESHOLD = 4;

// Replaces the old 25px edge dead-zone: only the PAGING action is skipped near
// the screen edges (leaving room for OS-level back gestures); interception
// still applies there so the sidebar can't be pulled out from the edge.
const EDGE_NO_PAGE_ZONE = 12;

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
	private startedNearEdge: boolean = false;

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
		// touchstart/touchmove listen on window in the CAPTURE phase: window is
		// the top of the capture chain, ahead of document and element listeners.
		// Capture-phase listeners on the same node fire in registration order,
		// and Obsidian core registered its gesture handler at app startup —
		// before this plugin loaded — so even a document-capture listener ran
		// too late. The entry guards restrict us to touches in the active note.
		window.addEventListener("touchstart", this.onTouchStart, {
			passive: true,
			capture: true,
		});
		// touchmove must be non-passive so we can preventDefault once the
		// gesture is locked as horizontal (blocks Obsidian's sidebar handler).
		window.addEventListener("touchmove", this.onTouchMove, {
			passive: false,
			capture: true,
		});
		// touchend/touchcancel stay on the container in bubble phase; they
		// only resolve gestures we already claimed on that container.
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
		// removeEventListener must pass the same capture flag used at attach,
		// or the listeners never actually get removed.
		window.removeEventListener("touchstart", this.onTouchStart, true);
		window.removeEventListener("touchmove", this.onTouchMove, true);
		if (!container) {
			return;
		}
		container.removeEventListener("touchend", this.onTouchEnd);
		container.removeEventListener("touchcancel", this.onTouchCancel);
	}

	// ⑤ multi-touch: ignore the gesture if more than one finger is down
	private onTouchStart = (e: TouchEvent): void => {
		// document-level listener: must not touch events outside the active
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
		// ① screen edge: near the left/right edge we still track and intercept
		// (the sidebar must not pop out), but won't page there — the OS's own
		// back gestures own that strip.
		this.startedNearEdge = this.nearScreenEdge(touch.clientX);
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
		// Runs unconditionally — the edge strip is intercepted too.
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
		// cannot fully close the race with OS-level gestures, which is exactly
		// what nearScreenEdge (25px) is reserved for — that stays untouched.
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
				// Edge strip: intercepted but never pages — reserved for OS
				// back gestures.
				if (!this.startedNearEdge) {
					this.onSwipe(dx < 0 ? "left" : "right");
				}
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
		this.startedNearEdge = false;
	}

	// ① screen edge heuristic (Obsidian native sidebar gestures live here)
	private nearScreenEdge(clientX: number): boolean {
		return (
			clientX < EDGE_NO_PAGE_ZONE ||
			clientX > window.innerWidth - EDGE_NO_PAGE_ZONE
		);
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
		// Resolve live: during the attach/detach re-bind window the cached
		// container is briefly null — a stale boundary here would let the walk
		// run all the way up to the document root.
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

	// Read-only: the cached container, falling back to the current leaf's view
	// container. Never assigns this.containerEl (attach()'s dedup relies on the
	// cache staying untouched during the re-bind window).
	private resolveContainer(): HTMLElement | null {
		return (
			this.containerEl ??
			(this.host.app.workspace.getMostRecentLeaf()?.view?.containerEl ?? null)
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
