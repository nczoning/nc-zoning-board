# NC Zoning Board — Brand Guidelines

## 1. Lore & Background (Night Corp Interface)

> *"What IS Night Corporation? Richard Night's legacy. The foundation stone of Night City. Its silent, watchful guardian."* — Night Corp netsite

The **NC Zoning Board** map is presented as an internal tool operated by **Night Corp**, the megacorporation dedicated to preserving and executing Richard Night's original vision for the city. Founded by Miriam Night after Richard's death, Night Corp acts as the largest contractor of public procurements within Night City—building roads, bridges, tunnels, and overseeing all civic development. 

As a Night Corp interface, the application should feel:
- **Bureaucratic but High-Tech:** Clean lines, structured data, and an undeniable corporate authority. It's the silent, watchful guardian of the city's infrastructure.
- **Civic-Minded:** Designed "for the public good". We manage the city's growth, infrastructure, and zoning.
- **Secretive & Protected:** Night Corp is known for its tight security and secretive policies. The interface should feel strictly authorized.

### Voice & Tone
- *In UI Copy:* Official, authoritative, and slightly sterile. 
  - *"Welcome to the NC Zoning Board internal repository."*
  - *"Unauthorized modification of zoning data is a Class 3 Corporate Offense."*
- *In Error States:* Emotionless bureaucracy. 
  - *"Error 404: Location data expunged or missing. Please contact your Night Corp liaison."*

---

## 2. Color Palette

Night Corp's aesthetic relies on conveying trust, stability, and control, contrasting with the neon-drenched chaos of the rest of the city.

| Name | Hex Code | Usage |
| :--- | :--- | :--- |
| **Corporate Navy (Primary)** | `#0a192f` | Deep backgrounds, establishing a solid, authoritative base. |
| **Zoning Cyan (Accent)** | `#00f0ff` | Primary buttons, active tabs, and critical highlights (The classic Cyberpunk UI cyan). |
| **Concrete Gray (Secondary)** | `#8a8d91` | Secondary text, inactive borders, and disabled states. |
| **Archival White (Text)** | `#e6f1ff` | Primary text. Not pure white to reduce eye strain on dark backgrounds. |
| **Warning Amber (Alerts)** | `#ffb300` | Warning states, overlaps, or critical alerts (like the "New Location" category). CSS: `--tertiary`. |
| **Approval Green (Success)** | `#00ff9d` | Success states, verified locations, or "Safe" zones. |

*Note: The map pins should utilize this palette, with specific colors assigned to different zoning categories (e.g., Apartments, Overhauls, New Structures).*

---

## 3. Typography

A four-tier scale. The tiers are additive: the display face sits **above** Orbitron, it does not replace it.

- **Tier 0 — Display / Brand:** `Night Corp Display` (local `@font-face`, derived from the logo; caps-only A-Z, 0-9, punctuation). CSS token `--font-nightcorp`. Reserve for the shortest, biggest, most branded moments only — wordmarks and boot/splash hero text. Rule of thumb: under ~20 characters, all-caps, and ≥28px. Never body copy, never a full sentence. Currently used on: the header wordmark (`NC ZONING BOARD`) and the welcome-modal splash.
- **Tier 1 — Heading:** `Orbitron` (Google Fonts). CSS token `--font-heading`. Screen titles, card headers, stat labels, nav, modal headers — all the structural lifting. More legible at small sizes and has the lowercase the display face lacks.
- **Tier 2 — Body & Data:** `Rajdhani` (Google Fonts). CSS token `--font-body`. Tooltips, descriptions, lists. Squarish but highly legible for dense data.
- **Tier 3 — Monospace (Logs/Coords):** `Fira Code` or generic `monospace` for coordinates and system outputs.

---

## 4. UI Elements & Styling

### Logos & Branding
- **Primary Logo:** `assets/img/nightcorp-logo.svg` (fill `#e6f1ff` so it reads on the navy header). Used in the `night-corp` theme header. Each theme swaps in its own logo file.
- **Favicon:** The Cyan favicon set in `assets/img/favicon/` — SVG + `.ico` + 16/32px PNG + apple-touch + `site.webmanifest`.
- **Parked / source assets:** `assets/brand/` holds brand assets not currently wired into the site (the compact monogram, candidate shard icons, an unused Gold favicon set). Kept version-controlled but out of the runtime `assets/img/` path. See `assets/brand/README.md`.

### Buttons & Toggles
- Sharp corners, no border radius (0px). Night Corp doesn't do "soft."
- Hover states should feel responsive, perhaps with a subtle glitch effect or a sharp color inversion (e.g., from Dark Navy with Cyan border to solid Cyan background with Navy text).

### Windows & Popups (The Map Overlay)
- **Borders:** Thin, 1px solid borders using the Cyan accent or a muted gray, perhaps with subtle "corner brackets" (e.g., `[ ]`) framing the corners.
- **Backgrounds:** Distinctly dark (Corporate Navy) with a slight, frosted-glass opacity `rgba(10, 25, 47, 0.9)` so the map is faintly visible beneath.

### Map Markers (Pins)
- Vector shapes. Clean geometric vectors over traditional rounded map pins.
- Diamonds, hexagons, or sharp squares.
- Icons should be minimalist line-art (SVG), not overly detailed illustrations.

---

## 5. The "Welcome" Modal

When a user first loads the map, they should be greeted by a Night Corp modal:

> **NIGHT CORP // URBAN PLANNING DIVISION**
> **Terminal ID:** NC-ZB-01
> 
> *Welcome to the NC Zoning Board prototype interface. This tool aggregates structural modifications and spatial anomalies across the Greater Night City area.*
> *This interface is currently in ALPHA. Data integrity is not guaranteed.*
>
> [ ACCESS TERMINAL ]
