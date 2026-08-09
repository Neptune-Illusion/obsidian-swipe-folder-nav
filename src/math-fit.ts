import type { App } from "obsidian";

// Hard floor for auto-scaling: below this the formula would be unreadable,
// and the CSS overflow-x: auto backstop takes over for extreme cases like
// very long matrices.
const MIN_SCALE = 0.55;
// Debounce for orientation/width changes; avoids jitter from resize storms.
const REFIT_DEBOUNCE_MS = 150;
// Second measurement to cover MathJax's slower first render.
const FOLLOWUP_MEASURE_MS = 250;
// Small breathing room so the scaled formula never sits flush against the
// container edge.
const FIT_MARGIN = 0.98;

export class MathFitter {
	// requestAnimationFrame and setTimeout ids live in separate number
	// spaces; keeping them apart means each can only be cancelled by the
	// matching API (never by the wrong one).
	private pendingFrames: Set<number> = new Set();
	private pendingTimeouts: Set<number> = new Set();
	private observers: ResizeObserver[] = [];
	private observedParents: Set<Element> = new Set();
	private resizeTimeouts: Map<Element, number> = new Map();

	constructor(_plugin: { app: App }) {}

	fit(el: HTMLElement): void {
		// MathJax renders asynchronously: measure a frame later, then once
		// more after a delay so slow first renders are covered too. Both runs
		// reset the font-size first, so re-running is a safe, idempotent op.
		this.schedule(() => this.run(el));
	}

	detach(): void {
		for (const id of this.pendingFrames) {
			cancelAnimationFrame(id);
		}
		this.pendingFrames.clear();
		for (const id of this.pendingTimeouts) {
			window.clearTimeout(id);
		}
		this.pendingTimeouts.clear();
		for (const id of this.resizeTimeouts.values()) {
			window.clearTimeout(id);
		}
		this.resizeTimeouts.clear();
		for (const observer of this.observers) {
			observer.disconnect();
		}
		this.observers = [];
		this.observedParents.clear();
	}

	private schedule(fn: () => void): void {
		const raf = requestAnimationFrame(() => {
			// Remove ourselves so the sets don't grow without bound across a
			// long session.
			this.pendingFrames.delete(raf);
			fn();
		});
		this.pendingFrames.add(raf);
		const timeout = window.setTimeout(() => {
			this.pendingTimeouts.delete(timeout);
			fn();
		}, FOLLOWUP_MEASURE_MS);
		this.pendingTimeouts.add(timeout);
	}

	private run(el: HTMLElement): void {
		try {
			const containers = el.querySelectorAll('mjx-container[display="true"]');
			for (const container of Array.from(containers)) {
				this.fitContainer(container as HTMLElement);
			}
		} catch {
			// Render-timing issues must never crash the plugin.
		}
	}

	private fitContainer(container: HTMLElement): void {
		try {
			const parent = container.parentElement;
			if (!parent || parent.clientWidth <= 0) {
				return;
			}
			// Clear any previously applied scale before measuring, so the
			// intrinsic width is measured instead of compounding on top of an
			// earlier scale.
			container.style.fontSize = "";
			const available = parent.clientWidth;
			const intrinsic = container.scrollWidth;
			// Observe the parent width unconditionally — a formula that fits
			// in landscape may overflow after rotating to portrait. observe()
			// is idempotent via observedParents, so calling it every time is
			// safe.
			this.observe(container);
			if (intrinsic <= available + 1) {
				return;
			}
			let ratio = (available / intrinsic) * FIT_MARGIN;
			if (ratio < MIN_SCALE) {
				ratio = MIN_SCALE;
			}
			container.style.fontSize = (ratio * 100).toFixed(1) + "%";
		} catch {
			// silently skip
		}
	}

	// Re-fit on width changes (orientation switch, sidebar toggle). Debounced
	// via timeout to avoid jitter. Skips if ResizeObserver is unavailable.
	private observe(container: HTMLElement): void {
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const parent = container.parentElement;
		if (!parent || this.observedParents.has(parent)) {
			return;
		}
		const observer = new ResizeObserver(() =>
			this.debouncedRefit(container)
		);
		observer.observe(parent);
		this.observers.push(observer);
		this.observedParents.add(parent);
	}

	private debouncedRefit(container: HTMLElement): void {
		const parent = container.parentElement;
		if (!parent) {
			return;
		}
		const existing = this.resizeTimeouts.get(parent);
		if (existing) {
			window.clearTimeout(existing);
		}
		const id = window.setTimeout(() => {
			this.resizeTimeouts.delete(parent);
			this.fitContainer(container);
		}, REFIT_DEBOUNCE_MS);
		this.resizeTimeouts.set(parent, id);
	}
}
