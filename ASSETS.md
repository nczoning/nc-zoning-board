# Asset Attribution & Licensing

## Code & Software

All original software code, scripts, stylesheets, and HTML markup are licensed under the **MIT License** (see `LICENSE` file).

This includes:
- `assets/js/`: Application logic, API integrations, utilities
- `assets/css/`: Styling and theming
- `scripts/`: Build and generation scripts
- `.github/workflows/`: CI/CD automation
- Configuration files

## Game Assets

The following assets are extracted from **Cyberpunk 2077** and are **NOT** covered by the MIT License. They are subject to **CD PROJEKT RED's Fan Content Policy**:

- Building footprints and geometry
- Road networks and metro systems
- District and subdistrict boundaries
- Terrain elevation data and contours
- Game textures, sprites, and visual assets
- In-game map imagery (8k, 16k source files)

### CD PROJEKT RED Fan Content Terms

**Non-Commercial Use Only**
- This project is free and non-commercial
- No revenue is generated from game assets
- Platform monetisation (YouTube/Twitch) is permitted for community creators

**Attribution Required**
This project displays the following notice in the Credits section of the in-app About panel:
> *"This is an unofficial fan work and is not approved/endorsed by CD PROJEKT RED."*

**Permitted Use**
- Community website and mapping tool ✅
- Modding support and coordination ✅
- Educational and documentation purposes ✅

**Prohibited Use**
- Commercial products or services ❌
- Game development or mobile apps ❌
- Incorporation into proprietary projects ❌

### Questions or Exceptions

If you have questions about specific uses of game assets or need an exception to these terms, contact CD PROJEKT RED directly:
- **Email:** legal@cdprojektred.com
- **Policy:** https://www.cdprojektred.com/en/fan-content

## Extracted Data Files

Coordinate data and metadata submitted by community members. The location
registry lives in a Cloudflare D1 database and is served publicly at
`https://api.nczoning.net/v1/locations`; `data/subdistricts.json` (world geometry
derived from the game) stays in this repository. `data/locations/` remains in the
repository as the pre-cutover record and is no longer where submissions land.

The terms are unchanged by where the data is stored. This data is:
- **Original contributor work**: contributors retain ownership
- **Licensed under MIT** (same as the software)
- **Validated against game coordinates**: accuracy verified through player testing

## Attribution

**NC Zoning Board** is maintained by the Cyberpunk 2077 modding community and hosted as a free resource on Cloudflare Pages.

- **Original Vision:** Kaoziun
- **Development Lead:** Spuddeh
- **UI/UX & Design:** Akiway
- **Contributors:** Locations Hub Council & community members

## Summary

| Component | Licence | Notes |
|-----------|---------|-------|
| Code & Scripts | MIT | Full source available |
| Documentation | MIT | All docs in `docs/` |
| Coordinate Data | MIT | Community-submitted |
| Game Assets | CD Projekt Red Fan Policy | Non-commercial, attributed |

---

**Last Updated:** 2026-03-30
