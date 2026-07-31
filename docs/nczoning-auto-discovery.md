# The NCZoning Tag

Tagging your mod **NCZoning** on Nexus puts it in the submit form's picker, with
its name, description and author already filled in. That is all it does.

> **⚠️ The tag no longer publishes a pin**
>
> Until 2.0.0 (2026-07-31), tagging a mod and pasting an `[NCZoning]` metadata
> block into its description put a pin on the map with no human step. **That path
> is retired.** The registry lives in a database now, and nothing reaches the map
> without a reviewer approving it.
>
> **If you kept your pin up to date by editing that block, it no longer works.**
> Editing your description will not move your pin, and you will not get an error.
> Use **Suggest a fix** on the pin's own popup instead.
>
> Pins already on the map are unaffected. The nine locations that arrived this
> way are ordinary records now.

---

## What tagging gets you

Tag your mod **NCZoning** on Nexus, then press **[+] Submit** on the map. Your
mod appears in the first step's picker, and selecting it prefills:

| Nexus field | Prefills | Notes |
| --- | --- | --- |
| `modId` | The Nexus link | Builds `nexusmods.com/cyberpunk2077/mods/<id>` |
| `name` | Mod name | Editable before you submit |
| `summary` | Description | The short summary, not the full description. Truncated to 500 characters |
| `uploader.name` | First author | Additional authors are yours to add |

Everything prefilled stays editable. The tag is a convenience, never a
requirement: if your mod is not tagged, or you would rather not tag it, paste its
Nexus link in the same step instead.

## What the map keeps reading from Nexus

Independent of the tag, for every mod that has a pin:

| Nexus field | Used as |
| --- | --- |
| `thumbnailUrl` | The image on the pin popup and sidebar entry |
| `updatedAt` | The `UPDATED` badge, within the API's `recently_updated_days` window |

Your mod's **description is no longer read at all**. Nothing is parsed out of it.

---

## Getting coordinates

1. Stand at the location in-game
2. Open the CET console (`~`)
3. Run: `local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))`
4. Use the **X**, **Y**, **Z** and **Yaw** values from the output; do not swap X and Y

See [Coordinate System](coordinate-system.md) for more detail and alternative
tools like Simple Location Manager.

---

## See also

- [Adding Mods](adding-mods.md) for the full field reference
- [Submission Pipeline](submission-pipeline.md) for what happens after you submit
