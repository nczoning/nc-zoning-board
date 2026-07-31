# NC Zoning Board: How You Can Help

This is a passion project built by and for the Cyberpunk 2077 modding community. No hierarchy, no job titles, no obligations: just modders helping modders. If you see something interesting and want to help, jump in! No experience required either: we're happy to learn together.

Here are the main areas where help would be awesome:

## 🛠️ Areas of Interest

### Frontend / Web

- **HTML / CSS / JavaScript:** Core site structure, styling, interactivity
- **Leaflet.js:** Map rendering, pins, popups, overlays
- **UX & Design:** Hover states, transitions, Cyberpunk aesthetic, custom pin icons
- **Coordinate system maths:** CET ↔ Leaflet transform calibration
- **SVG / GeoJSON:** Converting district polygons into Leaflet overlays
- **Spatial logic:** Pin clustering, coordinate transforms

### DevOps / Automation

- **GitHub Actions:** Maintaining submission workflows and deployments
- **Discord Webhooks:** Notification embed maintenance
- **Tile generation:** Slicing and regenerating map tiles at higher resolutions (Node.js/sharp)

### Documentation

- **Technical writing:** Keeping docs/ up to date as features ship
- **Contributor guides:** Helping others onboard

---

## 🤝 Interest Areas

Depending on what excites you, here are some natural areas where people tend to focus:

### 🖥️ Website & UI Work

Like working on interactive web stuff? The frontend is where a lot of the magic happens. We're actively building **district overlays** and **building/road/metro overlays**: extracting game geometry and aligning it to our map coordinate system. You'd use Leaflet.js, vanilla JS/CSS, and maybe some coordinate transforms.

Current active work: **[Spuddeh](https://www.nexusmods.com/profile/Spuddeh/mods?gameId=3333)** is developing overlays and **[Akiway](https://www.nexusmods.com/profile/Akiway/mods?gameId=3333)** leads UI/UX. If you want to collaborate, reach out!

---

### ⚙️ GitHub Automation & Tools

Into DevOps and automation? We maintain the **Cloudflare Worker and its D1 registry**, **tile generation**, **deployment workflows**, **API health monitoring** and **Discord alerting**. Node.js + YAML + a bit of Cloudflare and GitHub API knowledge.

Areas that sometimes need tweaks: submission workflows, CI/CD validation, secrets management, tile generation improvements.

---

### 🎨 Design & Icons

Want to make things look cool? Visual polish, **dark theme refinements**, UI refinements: this is where aesthetics meet functionality.

---

### ✍️ Documentation & Guides

Like writing clear docs? We need help keeping **docs/** current, writing **contributor onboarding guides**, and clarifying existing documentation. Markdown + Git knowledge.

---

## 🎯 What Needs Help Right Now

If you're looking for a good jumping-off point:

- **District overlays & map geometry:** The main project in progress. Extracting building footprints, roads, metro lines, and district boundaries from game data. Interested in mapping? This is where the action is.
- **Testing & feedback:** Use the map, submit location mods, and let us know what feels clunky or confusing. Real user feedback is incredibly valuable.
- **Anything else:** Have an idea for a feature or improvement? Just start a discussion on GitHub or ping us in Discord.
