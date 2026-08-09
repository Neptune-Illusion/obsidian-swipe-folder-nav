# FDS：Swipe Folder Navigation 技术功能说明书

版本对应：0.1.0 – 0.1.8
适用范围：Obsidian 移动端（iOS / Android），阅读模式
分发方式：GitHub Release + BRAT

---

## 1. 项目概述

Swipe Folder Navigation 是一个 Obsidian 移动端插件（id：`swipe-folder-nav`）。核心功能是：在阅读模式下左右滑动屏幕，切换当前笔记所在文件夹内的上一篇 / 下一篇笔记。

- 只导航 Markdown 文件（`.md`）
- 只统计当前文件所在文件夹的直接子文件，不递归子文件夹
- 默认按文件名排序（可改为按修改时间 / 创建时间）
- 到头默认不循环（可选开启循环）
- 仅在移动端、且当前视图为 Markdown 阅读（预览）模式时激活，桌面端与其他视图类型不响应

从 0.1.7 起附带第二个功能：阅读模式下超出页面宽度的 LaTeX 公式会被自动等比缩小到页面宽度以内。

开发过程是「真机反馈驱动」：lead 无法在真机上验证触摸行为，所有手势相关的问题都由用户在手机上实测后描述现象，开发侧据此定位与修复。本说明书记录了每个问题的根因、失败尝试与最终方案，供后续维护者理解代码为何呈当前形态。

---

## 2. 需求背景与演进

### 2.1 初始需求

用户原话只有一句：在 Obsidian 移动端左右滑动，切换同一文件夹下的上一篇 / 下一篇文档。其余规则由开发侧定下并在交付时向用户说明，用户未提出异议：

- 只导航 md 文件
- 按文件名排序
- 不递归子文件夹
- 到头默认不循环

### 2.2 首次真机反馈后的三次收窄

1. 「滑动时频繁弹出 obsidian sidebar，且切换不够平滑，频繁闪烁让眼睛很疼」—— 引出侧边栏手势冲突与切换闪烁两个问题（见 4.1、4.2）。
2. 「只有在 mobile 上处于 reading 模式下才激活左右滑动，其他模式都不触发」—— 插件由此只认阅读模式。原「编辑模式是否启用」（enableInEditMode）设置项因此永远不生效，被删除，设置项由 7 项减为 6 项。
3. 「区间收窄到 12px 给系统手势留余量。完全删除，不需要这个余量」—— 推翻了此前「屏幕边缘留出不翻页保护区」的折中方案，改为任意位置、包括最边缘都正常翻页。该保护区最终在 0.1.5 彻底移除（见 4.1 的漏洞二）。

### 2.3 LaTeX 相关需求的三阶段

方向变过两次，单独记录：

- **阶段一（0.1.2）**：用户报「页面超过宽度，例如因为 latex 公式，会导致插件不生效」。这是插件自身的 bug（`insideScrollable()` 误判，见 4.3），修误判。
- **阶段二（0.1.3）**：用户报「latex 超出页面限制，但是无滑动条」，给出两个选项：「修复这个 bug，或者限制 latex 公式不超过页面限制，不管是哪种方法，最小化修改」。开发侧选了加横向滚动，理由是缩放会让公式看不清。
- **阶段三（0.1.7）**：用户明确要求「让 latex 公式永远不超过页面限制，可以是整体缩小，或者自动换行」—— 推翻阶段二的滚动方案，改为自动缩放。自动换行经评估不可行（见 4.6）。

### 2.4 发布流程需求的变化

用户先说「以后较小改动只推送 commit，不新生成 release」，但紧接着的公式缩放改动又要求发版。由此确定的判据是**用户能否感知、是否需要真机验证**，而非改动大小。纯文档改动不发版（见 9.4）。

---

## 3. 系统架构

四个源文件模块，职责单一，通过 `main.ts` 装配：

| 文件 | 类 | 职责 |
|---|---|---|
| `src/main.ts` | `SwipeFolderNavPlugin` | 插件入口、生命周期、命令注册、设置页；把手势回调翻译为导航调用 |
| `src/swipe.ts` | `SwipeController` | 手势层：触摸事件的监听、拦截、方向判定、入口守卫 |
| `src/navigator.ts` | `FolderNavigator` | 导航层：找兄弟文件、排序、并发保护、打开相邻笔记 |
| `src/math-fit.ts` | `MathFitter` | 宽公式自动缩放的测量与适配 |

配套文件：`src/settings.ts`（设置结构与默认值，6 项）、`styles.css`（三处 CSS 规则，见 4.5、4.6）。

### 3.1 协作流程

1. `SwipeController` 在 `window` 捕获阶段监听 `touchstart / touchmove / touchend / touchcancel`，经 `enabledInCurrentMode()` 与 `isWithinActiveNote()` 守卫后判定手势。
2. 判定为横向滑动后，通过构造时传入的回调 `onSwipe(direction)` 通知 `main.ts` 的 `handleSwipe()`。
3. `handleSwipe()` 调用 `navigator.openRelative(direction === "left" ? 1 : -1)`。
4. `FolderNavigator.openRelative()` 计算目标文件并在当前 leaf 内 `openFile()`。
5. `MathFitter` 通过 `registerMarkdownPostProcessor` 在每个渲染完成的块上挂 `fit()`，与手势链路独立。

### 3.2 生命周期

`SwipeController` 构造时即注册 `active-leaf-change` 与 `layout-change` 两个工作区事件（统一指向 `attach()`），随后立即 `attach()`。监听器一旦绑定就常驻到插件卸载（`listenersBound` 幂等标志保证 `attach()` 不重复绑定）；「是否启用」的判定不放在绑定时刻，而是放在每次触摸发生时执行（原因见 4.4）。

### 3.3 设置项（6 项）

见第 5 章表 1。

---

## 4. 核心技术问题与解决方案

本章是全文重点。每个问题按「现象 → 根因 → 方案 → 代价或残留风险」组织，并保留前几次修错的过程——这些失败路径解释了代码为什么是现在这个形状。

### 4.1 侧边栏误弹：改了四次才定位

**现象**：阅读模式下横向滑动翻页时，Obsidian 原生侧边栏被拉出。

**根因**：Obsidian 的侧边栏拖拽手势由它自己的 JS 处理器实现，挂在祖先元素上，且在 `document` 及以上层级捕获。插件要抢先拿到触摸事件，必须战胜「注册更早、挂在更上层、阶段更靠前」三座大山。

**四次尝试及各自失败的原因**：

1. **0.1.1 — 给 touchmove 加 `preventDefault()`。失败。**
   `preventDefault()` 只阻止浏览器默认行为（滚动、缩放），不阻止其他 JS 监听器执行。Obsidian 的侧边栏处理器是 JS 代码，除非它主动检查 `e.defaultPrevented`，否则照常执行——而这一点无法保证。

2. **0.1.3 — 加 `stopPropagation()`，监听挂在 `view.containerEl` 冒泡阶段。失败。**
   Obsidian 的处理器挂在祖先元素，且很可能在捕获阶段。捕获阶段自上而下先于冒泡阶段，它比插件先拿到事件；到冒泡阶段再调 `stopPropagation()` 已经晚了。

3. **0.1.3 同版 — 改到 `document` 捕获阶段。仍然失败。**
   真正的原因是监听器**注册顺序**：捕获阶段传播顺序为 window → document → 祖先 → 目标，而同一节点上的多个捕获监听器按注册先后触发。Obsidian 核心在应用启动时就注册了手势处理器，插件是之后加载的，所以即使同在 `document` 捕获阶段，核心的回调先执行。

4. **0.1.4 — 挂到 `window` 捕获阶段，`stopPropagation()` 升级为 `stopImmediatePropagation()`。生效。**
   `window` 位于捕获链最顶端，先于任何 `document` 或元素上的捕获监听器；`stopImmediatePropagation()` 还能阻断**同一节点上注册在后的监听器**。这次生效。

**同版（0.1.4）补的两处独立漏洞**，均由用户提示方向后定位到（用户原话：「检查代码，是否有某个固定区域，或者短时间内多次滑动导致插件失效」）：

- **漏洞一（固定区域）**：此前 `nearScreenEdge` 的 25px 边缘保护区内，代码直接 `reset()` 返回，连 `stopPropagation` 都不调，等于完全不设防的通道，而侧边栏手势恰恰最容易从屏幕边缘触发。改为「照常拦截，只是不翻页」。该区间后来按用户要求收窄到 12px，并在 0.1.5 彻底删除——任意位置都正常翻页。
- **漏洞二（快速连滑）**：翻页触发 `active-leaf-change` 与 `layout-change`，进而调 `attach()`，而旧版 `attach()` 开头会 `detach()` 把 `containerEl` 置为 null。该空窗期内到达的触摸被入口守卫（`containerEl` 为 null 即放行）直接放过。现行为：守卫取不到缓存时实时解析当前视图容器（`resolveContainer()`，见 4.4）。

**兜底与最终形态**：

- 曾加 CSS `touch-action` 兜底，考虑到侧边栏拖拽可能部分依赖浏览器原生手势而非纯 JS 监听。该兜底在 0.1.6 因副作用被移除（见 4.5 原因 A）。
- 两级阈值设计（`src/swipe.ts` 的 `SIDEBAR_BLOCK_THRESHOLD = 4` 与 `DIRECTION_LOCK_THRESHOLD = 10`）：横向主导的位移一过 4px 立即 `stopImmediatePropagation()`（只阻断 JS 监听器，不阻止原生滚动，因此早拦不误伤纵向滚动）；10px 触发方向锁定。两级设计把「Obsidian 原生手势可能已提交」的窗口从 10px 压缩到 4px。

**代价 / 残留风险**：捕获阶段 + 4px 拦截只能把竞争窗口压窄，无法完全关闭与操作系统级手势（如返回手势、多指系统手势）的竞争。侧边栏拦截依赖监听顺序，任何在 window 捕获阶段更早注册的其他插件理论上仍可能先拿到事件。

### 4.2 切换闪烁

**现象**：滑动切换笔记时不平滑、频繁闪烁，用户反馈「眼睛疼」。

**根因**：四个原因叠加：

- `openFile` 传了显式 viewState（`{ state: { mode }, active: true }`），强制应用视图状态会走**视图重建**而非轻量内容替换。这是主因。
- `attach()` 同时挂在 `active-leaf-change` 和 `layout-change` 上，而 `openFile` 会同时触发两者，旧版每次翻页重复解绑重绑两次。
- `showNotice` 默认开启，每次翻页弹一个 Notice toast。
- 无并发保护，快速连滑会产生重叠的 `openFile` 调用。

**方案**：

- `openFile` 不传第二参数（`src/navigator.ts` 的 `openRelative()`）。在同一 leaf 内打开，Obsidian 自然保持当前模式，并走轻量内容替换。
- `attach()` 加去重 early return：`listenersBound` 幂等标志保证监听只绑一次（`src/swipe.ts`）。
- `showNotice` 默认值改为 `false`。
- `FolderNavigator` 加 `navigating` 布尔标志：进入时若为 true 直接返回，主体包在 `try/finally` 里复位，杜绝重叠调用。

**代价 / 残留风险**：`navigating` 标志是进程内互斥，不是队列——极速连滑时中间的若干次滑动会被静默丢弃，而不是排队逐一执行。这是有意的取舍：丢弃比排队更贴合「滑动翻页」的心智模型。

### 4.3 页面超宽导致插件在整篇笔记上完全失效

**现象**：笔记含宽 LaTeX 公式时，整篇笔记任何位置都滑不动。

**根因**：`insideScrollable()`（现为 `findScrollableAncestor()` / `isPageLevelScrollContainer()`）的遍历顺序错了——它在 `el === container` 的终止判断**之前**就先判定了 el 自身。宽公式把内容撑得比视口宽后，页面级滚动容器本身满足 `scrollWidth > clientWidth` 且 `overflow-x` 为 auto/scroll，于是页面上任意位置的 touchstart 都被判为「落在横向滚动区内」而放弃跟踪。该方法本意是保护代码块、表格这类**局部**横向滚动区，不应把页面级容器算进去。

**方案（三道防线，第三道是为了不依赖硬编码 class 列表）**：

1. 容器自身不参与判定：`findScrollableAncestor()` 的遍历条件 `el !== container` 从起点就排除容器本身。
2. 排除 Obsidian 页面级滚动容器的 class（`PAGE_LEVEL_SCROLL_CLASSES`：`markdown-preview-view`、`markdown-preview-sizer`、`markdown-reading-view`、`view-content`、`workspace-leaf-content`）。
3. 尺寸兜底：元素 `clientWidth` 接近容器 `clientWidth`（差值在 8px 内）即认定为页面级容器。这条兜住主题自定义 class 名的情况。

**方向感知让步（避免制造翻页死区）**：仅修根因不够——公式块本身是真正的局部横向滚动区（MathJax 给 `mjx-container` 加 `overflow-x`），在其上滑动仍完全不响应翻页，成为翻页死区。因此改为：touchstart 记下命中的滚动元素，touchmove 方向锁定为横向后，检查该元素在滑动方向上是否还能继续滚（`canStillScroll()`：左滑看 `scrollLeft + clientWidth < scrollWidth - 1`，右滑看 `scrollLeft > 1`）。还能滚就交还原生滚动，已到边界才翻页。效果是：先滚内容，滚到尽头再滑一次才翻页。

**代价 / 残留风险**：8px 尺寸容差在某些主题下可能把真正需要局部滚动的容器误判为页面级容器（见 7.3）。「先滚后翻」的语义对用户是新增的心智成本——在同一公式上要滑两次（一次滚到边界、一次翻页）。

### 4.4 进入编辑模式后插件永久失效（设计错误，非实现错误）

**现象**：阅读模式下双击进入编辑模式，再切回阅读模式，插件不再响应，必须重启插件或禁用再启用才恢复。

**根因**：时序竞争。旧版 `attach()` 在 `layout-change` 回调里同步调用 `enabledInCurrentMode()` 读取视图模式，但该事件触发时模式尚未切换完成，读到的是旧值。切回阅读模式时 `getMode()` 仍返回 `source`，判定为不启用于是 `detach()` 解绑并返回，此后再无事件触发 `attach()`。

**本质问题**：把「是否启用」的判定放在了**绑定监听器的时刻**，而那个时刻模式状态不可靠。正确做法是放在**用户真正触摸的时刻**——那时模式已稳定。

**方案**：

- 监听器改为常驻绑定（`listenersBound` 幂等标志），模式判定完全交给入口守卫 `enabledInCurrentMode()` 在触摸时执行。
- `touchend` / `touchcancel` 从容器冒泡改挂 `window` 捕获，不再依赖容器引用。
- `touchmove` 改为按手势动态绑定（touchstart 时绑、`reset()` 时摘，`touchMoveBound` 标志防重复）——因为非 passive 监听器常驻 window 会让浏览器每次 touchmove 都必须同步等待回调才能滚动，全应用范围有开销；改为只在实际跟踪手势期间存在，代价被限制在单次滑动内（见 6.1）。
- `containerEl` 字段整个删除，`resolveContainer()` 改为实时解析 `getMostRecentLeaf().view.containerEl`。

**代价 / 残留风险**：`enabledInCurrentMode()` 依赖 `MarkdownView.getMode()` 返回 `"preview"`；其他视图类型没有 `getMode()`，自然判为不启用，但这也意味着**插件在任何非 Markdown 阅读视图（画板、PDF 等）下都不工作**，这是设计边界而非遗漏。

### 4.5 CSS 导致公式被压缩、裁切、且滚动条拖不动（三处方案设计错误）

**现象**：0.1.6 之前，阅读模式下的块级公式被压缩变形、分式积分等结构显示不全、且横向滚动条存在但拖不动；代码块与表格一并受影响。

**根因（四处独立问题）**：

- **原因 A（拖不动）**：`touch-action` 的祖先限制与后代取交集——后代设 `auto` 无法恢复祖先已禁用的方向。0.1.4 曾在 `.markdown-preview-view` 上设 `pan-y` 禁止横向拖拽，同时给公式、代码块、表格设 `auto` 想放行，按 CSS 规范后者从未生效。用户能看到滚动条但拖不动，代码块和表格一并受影响。
- **原因 B（显示不全）**：`overflow-y: hidden` 裁掉了分式、积分号、求和号这类超出行框的结构。
- **原因 C（被压缩）**：`max-width: 100%` 压在 `mjx-container` 上限制了 MathJax 盒子的固有宽度，挤压内部布局，而非让外层容器去滚动它。
- **原因 D（一直空转）**：`.math-display` 是 span，行内元素上 `overflow-x` 不生效，该规则自引入起从未起过作用。

**方案**：

- 移除全部 `touch-action` 声明——侧边栏拦截交由 JS 层（4.1）单独负责，CSS 不再介入手势。
- 不声明 `overflow-y`，避免裁切。
- `.math-display` 提升为块级盒子并承担横向滚动（`display: block; max-width: 100%; overflow-x: auto`）。
- `mjx-container` 改为 `max-width: 100%` 与 `min-width: 0 !important`（`min-width: 0` 覆盖 MathJax 内联设置的 min-width，否则公式无法收缩；`overflow-y` 保持默认，不隐藏任何结构）。

**代价 / 残留风险**：横向滚动成为公式的兜底路径（0.55 缩放下限以下仍走滚动，见 4.6）；`.math-block` / `.math-display` 的包装类名在 Obsidian 不同版本间存在差异，选择器需同时覆盖（见 4.6 的选择器修正）。

### 4.6 宽公式自动缩放（0.1.7 / 0.1.8）

**背景**：用户要求公式永远不超过页面宽度，允许整体缩小或自动换行。这推翻了 0.1.3 的「可横向滚动」方案。

**为什么不能自动换行**：Obsidian 用 MathJax 3 的 CHTML 输出。MathJax 3 未实现 display 公式自动断行（v4 在做）；CSS 也无法在运算符处插入断点，强行用 `white-space` / `word-break` 会破坏公式内部布局。故只能等比缩小。

**为什么纯 CSS 不行**：CSS 无法测量「公式固有宽度 / 容器宽度」之比，`transform` 和 `font-size` 都需要具体数值。因此新增 `src/math-fit.ts`。

**为什么选 font-size 百分比而非 `transform: scale()`**：CHTML 输出以 em 为单位，改容器字号会等比缩放整个公式，且布局高度随之变化；`transform` 不影响盒模型，会在原位留下空白。

**关键参数与理由**（`src/math-fit.ts`）：

- `MIN_SCALE = 0.55`：再小就看不清。极端超长公式（如长矩阵）保留 CSS 那层 `overflow-x: auto` 兜底滚动，比缩成蚂蚁大小可用。
- `FIT_MARGIN = 0.98`：留一点余量，避免公式紧贴容器边缘。
- rAF + 250ms 两次测量（`schedule()`）：MathJax 异步渲染，post processor 回调执行时排版可能未完成，`scrollWidth` 不可靠。测量函数先重置 fontSize 再测，重复执行是幂等的。
- `ResizeObserver` + 150ms 防抖（`observe()` / `debouncedRefit()`）：应对横竖屏切换。

**0.1.7 的 CSS 选择器修正**：此前只写 `.math-display`，但阅读模式下 Obsidian 的包裹元素 class 可能是 `.math-block`。若选择器未匹配，唯一生效的就只剩 `mjx-container` 上的约束——而旧版恰恰缺了 `min-width: 0`，正是公式溢出页面的原因之一。改为 `:is(.math-block, .math-display)` 同时覆盖，并直接约束 `mjx-container` 以免依赖包裹元素存在；另加 `min-width: 0 !important` 覆盖 MathJax 内联设置的 min-width（内联样式必须 `!important` 才能覆盖）。

**0.1.8 修正 0.1.7 的三处缺陷**：

- **id 混用**：rAF 与 setTimeout 的 id 属于不同编号空间，此前混存于同一 Set 并对每个 id 同时调用两种取消函数，数字碰撞时会误取消无关任务。拆为 `pendingFrames` 与 `pendingTimeouts` 两个集合，各自用匹配的取消 API。
- **集合泄漏**：回调执行后未从集合移除自身 id，长会话下集合无界增长。改为在回调内自行清理。
- **横竖屏盲区**：`observe()` 此前只在公式实际被缩放的分支末尾调用，横屏下本可容纳的公式从未被观察，转竖屏变窄后不会重新适配、直接溢出。改为每次测量都挂载观察者（`observedParents` 已做去重）。

**代价 / 残留风险**：缩放是「有损」的——0.55 下限意味着极端公式仍需滚动查看；缩放会同步缩小公式的显示高度，但不影响文档内其他排版；MathJax 首次渲染慢时存在短暂未缩放窗口（两次测量只能覆盖主流时序，不能保证所有情况下都无闪烁）。

---

## 5. 功能规格

### 5.1 导航规则

- 目标集合：当前文件所在文件夹的**直接子文件**中扩展名为 md 的文件（`getSiblings()`）。
- 排序：`sortMode` 为 `name` 时按 `basename.localeCompare(…, { numeric: true })`（自然排序，`1.md` 在 `2.md` 之前）；`mtime` / `ctime` 按 `TFile.stat` 对应字段数值。`sortReverse` 为 true 时结果取反。
- 循环：`wrapAround` 开启时，末篇再右滑（下一篇）回到首篇，首篇再左滑回到末篇；仅当同文件夹内 md 文件不少于 2 个。
- 边界提示：到达首 / 末篇且未开启循环时，若 `showNotice` 开启则提示「Already at the first note」/「Already at the last note」。
- 陈旧文件保护：`openRelative()` 先用 `vault.getFileByPath()` 校验当前文件仍存在（工作区可能在外部删除后短暂保留文件对象），不存在则放弃导航。

### 5.2 手势判定流水线（`src/swipe.ts`）

监听布局：`touchstart` / `touchend` / `touchcancel` 常驻挂 `window` 捕获阶段（passive）；`touchmove` 只在跟踪手势期间动态绑定到 `window` 捕获（非 passive），`reset()` 时摘除。

1. **touchstart**：
   - 入口守卫 `isWithinActiveNote()`：移动端（`Platform.isMobile`）且当前视图 `getMode() === "preview"`（`enabledInCurrentMode()`），且触摸目标在 `resolveContainer()` 解析出的当前活动笔记容器内。侧边栏、设置页、命令面板的触摸直接放行。
   - 多指（`touches.length > 1`）→ 复位。
   - 文本选择进行中（`textSelectionActive()`，含编辑器的 `getSelection()` 与 DOM selection）→ 复位。
   - 记录命中的局部横向滚动元素（`findScrollableAncestor()`，排除页面级容器）。
   - 绑定非 passive touchmove，记录起点。
2. **touchmove**：
   - **Tier 1（4px）**：`max(|dx|, |dy|) > 4` 且 `|dx| > |dy|` 时立即 `stopImmediatePropagation()`——只阻断后续 JS 监听器，不阻止原生滚动。
   - **Tier 2（10px）方向锁定**：`max(|dx|, |dy|) <= 10` 不处理；否则按 `|dx| > |dy|` 锁定横向或纵向。纵向 → 复位，完全交还原生滚动。
   - **横向已锁定**：若手指在局部横向滚动区且该区在滑动方向上还能继续滚（`canStillScroll()`）→ 复位，交还原生滚动（先滚后翻，见 4.3）；否则 `preventDefault()` + `stopImmediatePropagation()`，吞掉该手势，避免浏览器默认动作与 Obsidian 侧边栏处理器拿到事件。
3. **touchend**：仅当在跟踪且方向已锁定为横向时判定：`|dx| >= minSwipeDistance` 且 `|dy| <= maxVerticalDrift` 且 `|dx| >= 2 * |dy|` → 触发翻页（左滑下一篇 +1，右滑上一篇 -1）。任何情况下最后都 `reset()`。
4. **touchcancel**：直接复位。

### 5.3 设置项

| 设置项 | 默认值 | 说明 |
|---|---|---|
| 排序方式 | 文件名 | `name` / `mtime` / `ctime` |
| 反向排序 | 关 | 颠倒上一篇 / 下一篇方向 |
| 循环切换 | 关 | 到达首 / 末篇时循环 |
| 最小滑动距离 | 80px | 触发切换的最小水平位移 |
| 最大垂直偏移 | 60px | 垂直位移超过该值视为滚动而非滑动 |
| 切换时提示 | 关 | 切换后在底部显示目标笔记名 |

`settings.ts` 的 `DEFAULT_SETTINGS` 与设置页一一对应，设置变更通过 `saveData()` 持久化。

### 5.4 命令（2 个）

- `goto-previous-note`：跳到上一篇（等价右滑）
- `goto-next-note`：跳到下一篇（等价左滑）

命令直接调 `navigator.openRelative(±1)`，可在命令面板或绑定快捷键使用；命令不受「仅阅读模式」限制，因为命令属于显式触发而非手势。

### 5.5 宽公式适配（`src/math-fit.ts`）

- 通过 `registerMarkdownPostProcessor` 对每个渲染完成的元素调 `fit()`。
- 测量：先重置 `fontSize`，再比对 `parent.clientWidth` 与 `container.scrollWidth`；仅在 `intrinsic > available + 1` 时缩小，比率 = `available / intrinsic × 0.98`，下限 `0.55`。
- 每次测量都挂载 `ResizeObserver` 观察父容器（幂等），宽度变化后 150ms 防抖重新适配，覆盖横竖屏切换。
- `detach()` 清理所有挂起的 rAF / timeout / observer。

---

## 6. 关键设计决策与权衡

1. **监听器放 window 捕获阶段 + 常驻绑定**：这是 4.1 与 4.4 共同收敛出的形态。捕获链最顶端 + 更早注册是压制 Obsidian 侧边栏处理器的唯一可靠位置；常驻绑定则绕开了「绑定时刻模式状态不可靠」的时序竞争。代价是这些监听器对全应用可见，因此守卫必须严格（`isWithinActiveNote()`），否则会误伤其他界面。

2. **非 passive touchmove 的动态绑定**：非 passive 监听器会迫使浏览器在每次 touchmove 都同步等待回调后才能滚动，全应用范围都有开销。若把 `touchmove` 常驻挂 window，副作用波及整个应用。当前实现只在「确实在跟踪一个手势」期间绑定，`reset()` 立即摘除，把性能代价限制在单次滑动内。`touchstart / touchend / touchcancel` 保持 passive，因为它们的回调从不调用 `preventDefault()`。

3. **拦截只用 stopImmediatePropagation，preventDefault 仅作为横向锁定后的补充**：`preventDefault()` 阻止的是浏览器默认行为而非其他 JS 监听器（4.1 第一次尝试的教训），所以拦截侧边栏靠的是 `stopImmediatePropagation()`；`preventDefault()` 只在方向已锁定横向、确实要接管手势时才调用，用于抑制原生横向滚动。

4. **缩放用 font-size 而非 transform**：transform 不影响盒模型，会在原位留下空白；CHTML 以 em 为单位，改字号是原生等比缩放。代价是必须动态测量，因此引入了一个测量模块和一个不可测尽的渲染时序窗口。

5. **自动缩放 vs 可滚动**：用户在 0.1.7 明确选择「永远不超宽」并推翻滚动方案。但缩放下限 0.55 保留了滚动兜底，意味着**极端公式仍需滚动查看**——这是「永远不超宽」与「可读性」之间的明确折中，而非承诺公式永不滚动。

6. **边缘不翻页区的删除**：从 25px 保护区 → 12px → 彻底删除，是用户要求「任意位置都翻页」的直接结果。代价是屏幕最边缘与系统返回手势的冲突窗口变宽，靠 4px 早期拦截（Tier 1）补偿。这是把用户可感知的交互（边缘也能翻页）置于系统手势的确定性之上。

7. **只在阅读模式生效**：用户明确限定。代价是编辑模式下没有此功能；`enableInEditMode` 设置项因此被删除，因为它永无生效机会。

8. **8px 尺寸容差**：用于在 class 名失效时识别页面级容器（4.3 第三道防线）。代价是在某些主题下可能把真正的局部滚动容器误判为页面级，导致其内无法翻页（7.3）。

9. **openFile 不传 viewState**：用轻量内容替换换取无闪烁切换（4.2 主因）。代价是放弃了对打开方式的显式控制——依赖 Obsidian 在同 leaf 内保持当前模式的默认行为。

10. **真机反馈驱动**：所有手势行为只能靠用户实测描述来验证，无法自动回归。这使每个问题都需要多轮「改→发版→用户测」循环，也意味着某些边界（如极端主题、特殊系统手势）可能长期未被覆盖。

---

## 7. 已知限制

1. **仅移动端阅读模式生效**：编辑模式、桌面端、以及画板 / PDF 等非 Markdown 视图均不响应手势。
2. **极端公式仍需滚动**：`MIN_SCALE = 0.55` 下限以下的超长公式（如长矩阵）缩到 55% 后仍可能超宽，此时回退到 CSS 的 `overflow-x: auto` 横向滚动。缩放是「有损」的，缩小的公式在手机上可能偏小。
3. **8px 尺寸容差可能误判**：主题自定义的、宽度接近容器的局部滚动容器可能被 `isPageLevelScrollContainer()` 视为页面级容器，从而不参与「先滚后翻」，该区域滑动会直接翻页。
4. **系统级手势残留竞争**：捕获阶段 + 4px 拦截无法完全关闭与操作系统级手势（返回手势、通知栏下拉等）的竞争窗口；极端情况下侧边栏仍可能被拉出。
5. **局部滚动区「先滚后翻」**：在公式 / 代码块 / 表格上需要先滚到边界再滑一次才翻页，单次滑动不能同时完成滚动与翻页。
6. **MathJax 渲染时序**：MathJax 异步渲染，极慢的首帧下可能短暂显示未缩放状态。
7. **导航范围固定**：只导航 md 直接子文件、按文件系统排序、不递归；`ctime` 排序依赖文件系统元数据，某些同步场景下不可靠。
8. **并发丢弃而非排队**：`navigating` 标志使极速连滑的中间滑动被静默丢弃（4.2）。

---

## 8. 版本历史

| 版本 | 内容 |
|---|---|
| 0.1.0 | 初始版本：移动端同文件夹滑动翻页，7 项设置。 |
| 0.1.1 | 限定移动端阅读模式才生效；首次尝试以 `preventDefault` 拦截侧边栏（失败）；修复切换闪烁；删除 `enableInEditMode`。 |
| 0.1.2 | 修复 `insideScrollable()` 误判：页面超宽（宽公式）导致整篇失效。 |
| 0.1.3 | 侧边栏拦截两次失败尝试（`stopPropagation` 于容器冒泡、`document` 捕获）；宽公式改为可横向滚动。 |
| 0.1.4 | 侧边栏拦截改 `window` 捕获 + `stopImmediatePropagation`（生效）；补近边缘保护区与快速连滑两处漏洞；加 CSS `touch-action` 兜底。 |
| 0.1.5 | 修复进入编辑模式后插件永久失效（常驻监听 + 入口守卫）；移除边缘不翻页区。 |
| 0.1.6 | 修复 CSS 导致公式压缩 / 裁切 / 拖不动；移除全部 `touch-action` 声明。 |
| 0.1.7 | 宽公式自动等比缩小至页面宽度内（新增 `math-fit.ts`）；修正 CSS 选择器与 `min-width`。 |
| 0.1.8 | 修正 `math-fit` 三处缺陷（id 混用、集合泄漏、横竖屏盲区）。 |

---

## 9. 构建与发布流程

### 9.1 构建

`npm run build` 依次执行：

1. `tsc -noEmit -skipLibCheck`——类型检查。
2. `node esbuild.config.mjs production`——打包 `src/main.ts` 为 `main.js`。

`main.js` 在 `.gitignore` 中，**不进仓库**，只作为 GitHub Release 附件分发。

### 9.2 BRAT 发布硬约束

插件通过 BRAT（Beta Reviewers Auto-update Test）从 GitHub Release 更新，以下均为硬性要求：

- Release tag **必须严格等于** `manifest.json` 的 `version`，且不带 `v` 前缀（如 `0.1.8`）。
- Release 必须是 **Published**，不能是 draft 或 prerelease（BRAT 默认读 latest release）。
- 三个附件 `main.js` / `manifest.json` / `styles.css` 必须齐全。
- 版本号需同步更新三处：`manifest.json`、`package.json`、`package-lock.json`。

### 9.3 已发布 Release 不得覆盖附件

0.1.7 曾用 `--clobber` 覆盖已发布 Release 的附件而未变更版本号。BRAT 依据附件内 manifest 的 `version` 判断更新，已安装 0.1.7 的用户因此收不到修复。此后改为以 0.1.8 重新发布。**现行规则：已发布的 Release 一律不得覆盖附件；要发新内容就升版本号发新 Release。**

发布核实必须以附件实际内容为准（下载比对，必要时比对 sha256）——附件内容与仓库文件可能不一致，本地 `origin/main` 引用也可能过期。

### 9.4 发布判据与推送约束

- 是否发版以「用户能否感知、是否需要真机验证」为准，而非改动大小。纯文档改动不发版、不升版本号。
- 本机环境存在全局 `url.insteadOf` 规则，把 github.com 重写到加速代理，`git push` 走该代理需要交互式凭据，非交互环境下会失败。处理方式：用 gh token 直连 github.com 推送，不修改用户的全局 git 配置。
- 注意：`git remote -v` 显示的是经重写后的地址；核对仓库实际存储值需用 `git config --local --get remote.origin.url`。

---

## 10. 后续可改进方向

1. **手势冲突的可配置化**：4px 拦截阈值、是否拦截侧边栏等目前是硬编码常量，可考虑暴露为设置项，适配不同系统手势习惯。
2. **编辑模式支持**：当前明确排除编辑模式；若未来支持，需处理与文本原生滚动、光标选择、文本选择的冲突。
3. **切换过渡动画**：当前是内容直换（为消除闪烁刻意不做显式动画）；可提供可选的开页过渡，并确保不重新引入闪烁。
4. **替代入口**：非触摸用户（桌面端、触控板）目前无入口；命令已存在，可扩展为按钮 / 状态栏项。
5. **公式换行跟进**：MathJax v4 实现 display 公式自动断行后，可重新评估「换行」方案，替代有损缩放。
6. **导航规则扩展**：忽略指定文件夹 / 笔记、按标签或 frontmatter 过滤、支持子文件夹递归（可选）。
7. **自动化回归**：当前全靠真机反馈驱动；引入基于触摸事件模拟的自动化测试可缩短「改→发版→用户测」循环，覆盖 4.1 / 4.3 / 4.4 等历史回归点。
8. **8px 容差收紧**：为 `isPageLevelScrollContainer()` 的尺寸兜底提供更精确的判定依据（如同时检查是否直接持有滚动行为），降低误判面。
