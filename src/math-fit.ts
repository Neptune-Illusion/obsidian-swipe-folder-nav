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
	private pendingIds: Set<number> = new Set();
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
		for (const id of this.pendingIds) {
			cancelAnimationFrame(id);
			window.clearTimeout(id);
		}
		this.pendingIds.clear();
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
		const raf = requestAnimationFrame(() => fn());
		this.pendingIds.add(raf);
		const timeout = window.setTimeout(() => fn(), FOLLOWUP_MEASURE_MS);
		this.pendingIds.add(timeout);
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
			if (intrinsic <= available + 1) {
				return;
			}
			let ratio = (available / intrinsic) * FIT_MARGIN;
			if (ratio < MIN_SCALE) {
				ratio = MIN_SCALE;
			}
			container.style.fontSize = (ratio * 100).toFixed(1) + "%";
			this.observe(container);
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
