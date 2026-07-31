# Contributing to NC Zoning Board

Thanks for wanting to help! There are a few different ways to contribute depending on your skills.

---

## 🗺️ Submitting a Mod Location

Submit it from the map. There is one way to do this now, and it needs no GitHub
account and no Git knowledge.

1. Get your in-game coordinates from the CET console (see
   **[docs/adding-mods.md](docs/adding-mods.md)** for the exact command).
2. Open [nczoning.net](https://nczoning.net) and press **[+] Submit**.
3. Pick your mod, or paste its Nexus link if it is not listed. Tagging your mod
   **NCZoning** on Nexus puts it in the picker with its name, description and
   author already filled in.
4. Fill in the rest and send it. A maintainer reviews it, and approving it puts
   your pin on the map within seconds.

Already have a pin? Correct it from its own popup with **Suggest a fix**, which
sends only the fields you change. The same form can request removal instead.

> **The GitHub issue forms are gone**, and so is the metadata block that used to
> be pasted into a Nexus description. Both wrote locations into git, and the
> registry no longer lives there, so neither could reach the map. The
> **NCZoning** tag is still worth adding: it is what puts your mod in the
> picker.

---

## 🛠️ Contributing Code or Docs

### Getting Started

```bash
# Fork the repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/nc-zoning-board.git
cd nc-zoning-board

# Run locally
npx serve .
# Open http://localhost:3000
```

### Project Structure

```text
index.html              # Entry point
assets/
  js/app.js             # Map logic (Leaflet, pins, popups)
  css/style.css         # Cyberpunk-themed styles
data/
  locations/            # Individual mod JSON files
  tags.json             # Global tag registry
mods.json               # Compiled mod registry (Git ignored)
mods.schema.json        # JSON Schema for validation
scripts/
  build_mods.js         # Compiles data/locations/*.json -> mods.json
  validate_tags.js      # Validates used tags against tags.json
  generate_tiles.js     # Map tile generator (Node.js + sharp)
docs/                   # Architecture, guides, coordinate system
.github/
  workflows/            # CI/CD - validation, submission, deployment
  ISSUE_TEMPLATE/       # Mod submission form
```

### Before Opening a PR

Just do a quick sanity check:

- Run `node scripts/build_mods.js` to compile data
- Run `node scripts/validate_tags.js` to check tag validity
- If you changed map/coordinate stuff, verify pins still render correctly
- Keep it focused: one feature or fix per PR

If something breaks, let us know! We can debug together.

---

## 🤝 Ways to Help

This is a community passion project built by modders helping each other. If you've got some spare time and want to contribute, great! No pressure if you can't. Here are the areas where help would be awesome:

### 🖥️ Frontend & Web

Like building websites? We're working on district overlays, improving pin clustering, custom Cyberpunk-themed icons, and general UI polish. You'd work with Leaflet.js and vanilla JS/CSS.

### ⚙️ DevOps & Automation

Comfortable with GitHub Actions? We maintain the submission workflow, tile generation, deployment pipeline, and Discord webhook integrations. Node.js + YAML.

### 🎨 Design & Polish

Into icon design or dark-theme UI? We'd love Cyberpunk-style custom pins, visual consistency, and overall aesthetic improvements.

### ✍️ Documentation & Writing

Help keep docs/ current, write guides for new contributors, or clarify existing docs. Markdown + basic Git knowledge.

**Want to help?** Join the **[Locations Hub Discord](https://discord.gg/sc4yEx2fNf)** and say hi in the general channel. We'd love to chat about what you're interested in!

---

## 📌 Code Standards

- **JavaScript:** Vanilla ES6+, no build step, no frameworks
- **CSS:** Plain CSS. Keep the Cyberpunk aesthetic (Orbitron/Rajdhani fonts, dark theme)
- **JSON:** All `mods.json` entries must pass schema validation
- **Commit messages:** Use [Conventional Commits](https://www.conventionalcommits.org/) style (`feat:`, `fix:`, `docs:`, `chore:`)

---

## 🔍 Useful Docs

- [NCZoning Auto-Discovery](docs/nczoning-auto-discovery.md): adding mods directly from Nexus
- [Architecture](docs/architecture.md): file structure, data flow, secrets
- [Submission Pipeline](docs/submission-pipeline.md): how GitHub Actions handles new mod entries
- [Coordinate System](docs/coordinate-system.md): CET ↔ Leaflet transform, calibration data
- [Adding Mods](docs/adding-mods.md): schema reference, getting coordinates, GitHub submission methods
- [Tag Registry](docs/tags.md): current tags, and how to add, modify, or remove tags
- [Tile Generation](docs/tile-generation.md): how the map tiles are generated and upgraded
- [Skills & Roles](docs/skills-and-roles.md): full role descriptions and recruiting priorities
- [Roadmap](https://github.com/orgs/nczoning/projects/1): what's shipped, in progress and planned. The project board *is* the roadmap, so it is never out of date

---

*Night City's got a lot of corners. Help us map them all.* 🌃
