import { App, Platform, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS, SwipeFolderNavSettings } from "./settings";
import { SwipeController, SwipeDirection } from "./swipe";
import { FolderNavigator } from "./navigator";
import { MathFitter } from "./math-fit";
import { scrollPastEnd } from "./desktop-navigation";

/**
 * Mount-point contracts (implemented).
 *
 * 1) Gesture layer — src/swipe.ts
 *    class SwipeController {
 *      constructor(host, onSwipe: (direction: 'left' | 'right') => void)
 *      // host: { app: App; settings: SwipeFolderNavSettings; registerEvent: Plugin['registerEvent'] }
 *      attach(): void
 *      detach(): void
 *    }
 *    onSwipe('left')  → navigator.openRelative(+1)  // next
 *    onSwipe('right') → navigator.openRelative(-1)  // prev
 *
 * 2) Navigation logic — src/navigator.ts
 *    class FolderNavigator {
 *      constructor(plugin: SwipeFolderNavPlugin)  // reads plugin.settings live
 *      detach(): void
 *      getSiblings(file: TFile): TFile[]
 *      getNext(file?: TFile | null): TFile | null
 *      getPrev(file?: TFile | null): TFile | null
 *      openRelative(offset: 1 | -1): Promise<boolean>
 *    }
 *
 * 3) Settings tab — implemented in SwipeFolderNavSettingTab.display()
 */
export default class SwipeFolderNavPlugin extends Plugin {
	settings!: SwipeFolderNavSettings;

	/** Gesture layer controller (src/swipe.ts). */
	private gestureController: SwipeController | null = null;

	/** Folder navigation logic (src/navigator.ts). */
	private navigator: FolderNavigator | null = null;

	/** Wide-math auto-fit (src/math-fit.ts). */
	private mathFitter: MathFitter | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.navigator = new FolderNavigator(this);
		this.register(() => this.navigator?.detach());

		this.gestureController = new SwipeController(this, (direction) =>
			this.handleSwipe(direction)
		);
		this.register(() => this.gestureController?.detach());

		this.mathFitter = new MathFitter(this);
		this.registerMarkdownPostProcessor((el) => this.mathFitter?.fit(el));
		this.register(() => this.mathFitter?.detach());

		this.addSettingTab(new SwipeFolderNavSettingTab(this.app, this));

		this.addCommand({
			id: "goto-previous-note",
			name: "跳到上一篇",
			callback: () => {
				void this.navigator?.openRelative(-1);
			},
		});
		this.addCommand({
			id: "goto-next-note",
			name: "跳到下一篇",
			callback: () => {
				void this.navigator?.openRelative(1);
			},
		});

		if (Platform.isDesktop) {
			this.addCommand({
				id: "desktop-navigate-next-file",
				name: "Navigate to next file",
				checkCallback: (checking) => this.runDesktopNavigation(1, checking),
			});
			this.addCommand({
				id: "desktop-navigate-previous-file",
				name: "Navigate to previous file",
				checkCallback: (checking) => this.runDesktopNavigation(-1, checking),
			});
			this.addCommand({
				id: "desktop-scroll-past-end",
				name: "Scroll past end of note",
				editorCallback: (editor) => scrollPastEnd(editor),
			});
		}
	}

	onunload(): void {
		this.gestureController?.detach();
		this.gestureController = null;
		this.navigator?.detach();
		this.navigator = null;
		this.mathFitter?.detach();
		this.mathFitter = null;
	}

	/**
	 * Handles a swipe gesture from the gesture layer.
	 * Left swipe → next note (+1), right swipe → previous note (-1).
	 */
	private handleSwipe(direction: SwipeDirection): void {
		void this.navigator?.openRelative(direction === "left" ? 1 : -1);
	}

	private runDesktopNavigation(offset: 1 | -1, checking: boolean): boolean {
		if (!this.app.workspace.getActiveFile()) return false;
		if (!checking) void this.navigator?.openDesktopRelative(offset);
		return true;
	}

	/**
	 * Re-evaluate the gesture attach state. No caller remains in the settings
	 * panel since enableInEditMode was removed in 0.1.1; kept for programmatic
	 * re-attach or future settings that affect attach() decisions.
	 */
	refreshGesture(): void {
		this.gestureController?.attach();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

/** Settings tab — all 6 plugin settings. */
export class SwipeFolderNavSettingTab extends PluginSettingTab {
	plugin: SwipeFolderNavPlugin;

	constructor(app: App, plugin: SwipeFolderNavPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("排序方式")
			.setDesc("同文件夹内笔记的排序依据，决定上一篇/下一篇的顺序")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("name", "文件名")
					.addOption("mtime", "修改时间")
					.addOption("ctime", "创建时间")
					.setValue(this.plugin.settings.sortMode)
					.onChange(async (value) => {
						this.plugin.settings.sortMode = value as
							| "name"
							| "mtime"
							| "ctime";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("反向排序")
			.setDesc("颠倒上一篇/下一篇的方向")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.sortReverse)
					.onChange(async (value) => {
						this.plugin.settings.sortReverse = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("循环切换")
			.setDesc("到达首篇/末篇时循环回到另一端")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.wrapAround)
					.onChange(async (value) => {
						this.plugin.settings.wrapAround = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("最小滑动距离")
			.setDesc("触发切换所需的最小水平位移（px）")
			.addSlider((slider) =>
				slider
					.setLimits(20, 300, 5)
					.setValue(this.plugin.settings.minSwipeDistance)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.minSwipeDistance = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("最大垂直偏移")
			.setDesc("垂直位移超过该值（px）时视为滚动而非滑动")
			.addSlider((slider) =>
				slider
					.setLimits(0, 200, 5)
					.setValue(this.plugin.settings.maxVerticalDrift)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxVerticalDrift = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("切换时提示")
			.setDesc("切换笔记时在底部显示目标笔记名")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showNotice)
					.onChange(async (value) => {
						this.plugin.settings.showNotice = value;
						await this.plugin.saveSettings();
					})
			);

		if (Platform.isDesktop) {
			new Setting(containerEl)
				.setName("桌面端导航范围")
				.setDesc("桌面端命令在当前文件夹或整个 vault 中切换笔记")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("folder", "当前文件夹")
						.addOption("vault", "整个 vault")
						.setValue(this.plugin.settings.desktopNavigationScope)
						.onChange(async (value) => {
							this.plugin.settings.desktopNavigationScope = value as "folder" | "vault";
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("跟随文件浏览器排序")
				.setDesc("桌面端命令使用 File Explorer 当前的文件名、创建时间或修改时间排序")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.desktopFollowFileExplorerSort)
						.onChange(async (value) => {
							this.plugin.settings.desktopFollowFileExplorerSort = value;
							await this.plugin.saveSettings();
						})
				);
		}
	}
}
