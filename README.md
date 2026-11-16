# ARAM Mayhem Overlay

A small Windows overlay for League of Legends ARAM: Mayhem.

- Grade badges (S to D) above each augment card at pick time
- Combo and niche-build labels for your champion
- A panel with the full augment list and item build
- Hidden in game until you press a key

## Install

Download the zip from Releases (or from the chat it was built in), unzip, run `ARAM Mayhem Overlay.exe`.
League must be in Borderless mode, in English, on the main monitor.

## Updates

The app code lives in [`app/`](app). On start, the app reads `app/manifest.json` from this repo.
If the version there is newer, it downloads the files, checks each SHA-256, and runs them.

To publish a change: edit files in `app/`, run `node tools/release.js <version>`, commit and push to `main`.

## Data

- Augment rankings and builds: U.GG data files (unofficial, may change)
- Pick rates and combos: [arammayhem.com](https://arammayhem.com/data/) (CC BY 4.0)
- Names and icons: Riot Data Dragon

Riot does not publish ARAM: Mayhem match data, so there are no true Mayhem win rates.

Not made or endorsed by Riot Games, U.GG or arammayhem.com.
