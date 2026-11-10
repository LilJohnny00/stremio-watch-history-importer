# Stremio Watch History Importer

Bring your old watch history from **Netflix, Crunchyroll, Prime Video and Disney+** into **Trakt**, then pull it into **Stremio** with one click.

- Runs **entirely on your PC**. It only talks to Trakt.
- Handles **episodes and movies**.
- **Won't create duplicates.** It checks your Trakt history before adding anything.
- **Preview first.** Nothing is written until you click Import.

> Not affiliated with Stremio, Trakt, Netflix, Crunchyroll, Amazon or Disney. It's a personal tool that reads **your own** history, using **your own** logged-in sessions.

---

## Before you start

1. A free **Trakt account**: <https://trakt.tv>
2. **Trakt VIP**: <https://trakt.tv/vip>. You need it to create the API app in Step 1. You can cancel once you've finished importing.
3. **Node.js (LTS)**: <https://nodejs.org>. It's the only thing to install. No `npm install` needed.

## Run it

1. Download this repo (**Code → Download ZIP**) and unzip it into one folder.
2. **Windows:** double-click `Start-Trakt-Backfill.bat`.
   **Mac/Linux:** run `node server.mjs` in the folder.
3. Your browser opens <http://127.0.0.1:8787>. Leave the console window open while you use the app.

## Using the app

1. **Connect Trakt.** Create an app at <https://trakt.tv/oauth/applications/new> with the Redirect URI `urn:ietf:wg:oauth:2.0:oob`, then paste the Client ID and Secret into the app. Select **Save**, then **Log in to Trakt** and enter the code shown.
2. **Pick a service.** Instructions appear in the app for each one.
3. **Upload** your history file (drag and drop works).
4. **Preview**, check the summary, then **Import to Trakt**. Do **one service at a time**.
5. **Send it to Stremio.** Go to <https://www.stremio.com/acc-settings> → **Integrations** → make sure Trakt is connected → **Import**. (Stremio allows this once every 24 hours.)

### Getting your history file

| Service | How | File |
|---|---|---|
| **Netflix** | Account → Profiles → *your profile* → Viewing activity → **Download all** | `NetflixViewingActivity.csv` |
| **Crunchyroll** | In-app guide: copy 2 values from DevTools → **Build my script** → paste in Console | `crunchyroll-history-full.json` |
| **Prime Video** | In-app guide: **Copy Prime script** → paste in Console on `primevideo.com/settings/watch-history` | `primevideo-history.json` |
| **Disney+** | No history page. Request your data via Disney's privacy portal (link in app), then convert the PDF to CSV | `.csv` |

Netflix and Prime Video history is **per profile**. Export from the profile you actually watch on.

## Confidence levels

| Level | What happens |
|---|---|
| **High** | Imported automatically |
| **Medium** | Shown for review, **not** imported |
| **Low / No match** | Skipped |

## Known limitations

- **Netflix** provides no episode numbers, so episodes are matched by title.
- **Disney+** provides episode titles only, so episodes are matched by title.
- **Prime Video:** some rows say only "Season 1" with no show name. These can't be matched, so add them on Trakt by hand if you need them.
- **Crunchyroll:** absolute episode numbers (e.g. "S3E48") are remapped to the real season and episode using Trakt's season data.
- **Watch dates:** items are recorded on Trakt using the episode's air date (or the movie's release date), not the date you watched them.

## Your data and privacy

- Your Trakt keys and login are saved locally as `config.json` and `token.json`. **Never share or commit these.** They're already in `.gitignore`.
- History files stay on your PC. They're uploaded only to the local app, never to the internet.
- The local server only listens on `127.0.0.1` and rejects requests from other websites.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Node.js is not installed" | Install the LTS version from nodejs.org, then run the `.bat` again |
| Buttons greyed out | You need both **Logged in ✓** and a parsed file |
| Chrome won't let you paste in Console | Type `allow pasting`, press Enter, then paste again |
| Crunchyroll script returns 401 | The values expired after a few minutes. Grab fresh ones from DevTools |
| 401 during import | Log in to Trakt again and retry. It's safe because nothing is duplicated |

## Files

| File | Purpose |
|---|---|
| `Start-Trakt-Backfill.bat` | Windows launcher |
| `server.mjs` | Local app server |
| `index.html` | The app UI |
| `crunchyroll-help.html`, `primevideo-help.html` | Export guides shown in the app |
| `matcher.mjs` | Trakt matching engine |
| `parsers.mjs` | Converts each service's export |

## Licence

MIT. See [LICENSE](LICENSE).
