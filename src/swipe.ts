import { Platform, type App, type Plugin } from "obsidian";
import type { SwipeFolderNavSettings } from "./settings";

const DIRECTION_LOCK_THRESHOLD = 10;

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
		// ③ horizontally scrollable ancestor (code blocks / tables)
		if (this.insideScrollable(e.target)) {
			this.reset();
			return;
		}
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

	// ③ any ancestor up to the content container that scrolls horizontally
	private insideScrollable(target: EventTarget | null): boolean {
		const container = this.containerEl;
		let el = target instanceof Element ? target : null;
		while (el && container) {
			if (el.scrollWidth > el.clientWidth + 1) {
				const ox = window.getComputedStyle(el).overflowX;
				if (ox === "auto" || ox === "scroll" || ox === "overlay") {
					return true;
				}
			}
			if (el === container) {
				break;
			}
			el = el.parentElement;
		}
		return false;
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
