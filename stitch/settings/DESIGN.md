# Design System Specification: Technical Node-Based Orchestration

## 1. Overview & Creative North Star: "The Orchestral Logic"
The North Star for this design system is **The Orchestral Logic**. Unlike traditional enterprise software that feels rigid and static, this system treats complex data pipelines as a living, breathing score. We move away from the "cluttered dashboard" aesthetic and toward a high-end, editorial technical environment.

**The Design Philosophy:**
*   **Intentional Asymmetry:** Sidebars and node panels are not perfectly mirrored. One side may prioritize density while the other prioritizes breathing room.
*   **Tonal Depth over Line Work:** We explicitly reject the "grid of boxes" look. Structure is defined by the weight of color and the layering of surfaces, not by 1px borders.
*   **Technical Elegance:** We pair the brutalist utility of monospaced type with the softness of large-radius corners (`xl: 1.5rem`) and organic, curved SVG connections.

---

## 2. Colors: Tonal Hierarchy & The "No-Line" Rule
The palette is rooted in deep obsidian tones to provide a "void" where colorful logic can shine.

### The Surface Stack
*   **Canvas (Background):** `#131313` (`surface`). This is your infinite floor.
*   **Secondary Workspaces:** Use `surface_container_low` (`#1c1b1b`) for sidebars.
*   **Active Node Bodies:** Use `surface_container_high` (`#2a2a2a`) to make nodes feel physically closer to the user.

### The "No-Line" Rule
**Explicit Instruction:** Do not use 1px solid borders to define sections. 
*   Instead of drawing a line between the sidebar and the canvas, change the background token from `surface` to `surface_container_low`. 
*   If a node needs a border to indicate selection, use a `surface_tint` (`#cdbdff`) glow with a blur, rather than a stroke.

### Functional High-Contrast (Data Types)
Logic types are color-coded to ensure instant recognition across a sprawling graph:
*   **File/Stream:** `secondary` (`#9ecaff`) - Blue
*   **Boolean/Logic:** `tertiary` (`#00e475`) - Green
*   **Text/Strings:** `primary_fixed` (`#e8deff`) - Subtle Lavender/Yellow-adjacent
*   **Node/Flow:** `primary_container` (`#7c4dff`) - Deep Purple

---

## 3. Typography: Editorial Utility
We utilize a dual-font strategy to balance high-end readability with technical precision.

*   **Space Grotesk (Display/Headers):** Used for `headline` and `label` tokens. Its geometric quirks provide a "boutique tech" feel. Use `label-md` for node headers to keep them legible but sophisticated.
*   **Inter (Body/Data):** Used for `title` and `body` tokens. This is the workhorse for metadata and input fields.
*   **Monospaced Technicals:** All port labels and code snippets must use a monospaced variant of Inter (or a system mono) at `label-sm` (`0.6875rem`) to emphasize the "under-the-hood" nature of the tool.

---

## 4. Elevation & Depth: The Layering Principle
Depth is not simulated with shadows alone; it is achieved through **Tonal Layering**.

*   **The Glassmorphism Rule:** Floating menus (like the "Add Node" search) must use a semi-transparent `surface_container_highest` (`#353534`) with a `backdrop-filter: blur(20px)`. This prevents the floating element from feeling "disconnected" from the graph behind it.
*   **Ambient Shadows:** When a node is dragged, apply a shadow using the `on_surface` color at 6% opacity with a 32px blur. It should feel like a soft ambient occlusion, not a drop shadow.
*   **Ghost Borders:** For accessibility on inactive nodes, use `outline_variant` (`#494455`) at 15% opacity. It should be felt, not seen.

---

## 5. Components: Primitives for the Pipeline

### The Node Box (The Hero Component)
*   **Container:** `surface_container_high`, `rounded-xl` (1.5rem).
*   **Header:** A slightly lighter `surface_container_highest` background, pinned to the top with `rounded-t-xl`. No divider line; use padding (`3.5`: `0.75rem`) to create separation.
*   **Ports:** Circular inputs/outputs using the functional colors defined in Section 2. Ports must have a 2px `surface` "gap" around them to prevent color bleed into the node body.

### Buttons (Actionable Logic)
*   **Primary:** Background `primary_container`, Text `on_primary_container`. Use `rounded-full` for a pill shape that contrasts against the rectangular nodes.
*   **Ghost (Secondary):** No background. Text `primary`. Border is `outline_variant` at 20% opacity.

### Inputs & Fields
*   **Fields:** Background `surface_container_lowest` (`#0e0e0e`). This "sunken" look provides an immediate visual cue that the area is interactive.
*   **Focus State:** Shift background to `surface_bright` and add a subtle `primary` outer glow.

### The Connection Edge (SVG Lines)
*   **Path:** Cubic Bezier curves.
*   **Thickness:** 2px.
*   **Style:** Use a gradient stroke from the "Output Port" color to the "Input Port" color. This visualizes data flow directionality without needing arrows.

---

## 6. Do’s and Don’ts

### Do
*   **Do** use `surface_container_low` for the background grid lines (1px width, 20px spacing) to keep them nearly invisible until focused.
*   **Do** use `4: 0.9rem` spacing as your standard "breath" between internal node elements.
*   **Do** allow nodes to overlap slightly when being moved; the backdrop blur on headers will maintain legibility.

### Don’t
*   **Don't** use pure white (#FFFFFF) for text. Always use `on_surface` (`#e5e2e1`) to reduce eye strain in the dark environment.
*   **Don't** use sharp 90-degree corners. Even "technical" elements should have at least a `sm: 0.25rem` radius to feel premium.
*   **Don't** use divider lines in lists. Use a `0.2rem` (1.5) vertical gap and subtle hover states (`surface_bright`) to distinguish items.

---

## 7. Signature Interaction: "The Pulse"
To elevate the experience, when a node is actively processing, the `outline` should not flash. Instead, the background should subtly transition between `surface_container_high` and `surface_variant` using a 2-second ease-in-out sine wave. This "breathing" state communicates life within the pipeline without the jarring effect of standard "loading" spinners.