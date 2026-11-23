# PeopleLog (contacts-prompter)

A private memory aid for the people you meet. After meeting someone, tap ✎ and write (or dictate, e.g. with Wispr Flow) what you learned, and Gemini turns it into proposed updates (a note, things to ask next time, key dates, connections) that you approve before anything is saved.

Runs as an installable web app (PWA) on GitHub Pages, with sign-in and sync through Firebase. Works offline; changes sync when you're back online.

## Using it

- **Big ✎ button** – write about one or more people. Unsaved drafts are kept on the device. The AI matches names to people already in your list, or proposes new ones. Untick or edit anything on the review screen, then Save.
- **Home screen prompts** – key dates in the next 30 days and people with open "ask next time" items.
- **Person page** – who they are, things to ask (tick when done), key dates, connections, and a dated notes timeline. "Write a note about this person" aims the note at them.
- **Phone contact** – on Android Chrome, link a person to a phonebook contact (on their page, or when adding them). PeopleLog keeps a copy of the name, numbers and emails, with Call / Text / Email buttons; use *Refresh from phone* if they change. Browsers can't hold a live link into the phonebook. Phone details are never sent to Gemini.
- **Settings** – Gemini key and model, bulk import from pasted text, backup download and restore, sign out (also clears the copy stored on the device).

## One-off setup

1. **Firebase → Authentication → Sign-in method:** enable Google.
2. **Firebase → Authentication → Settings → Authorised domains:** add `nickjcowley.github.io`.
3. **Firebase → Firestore → Rules:** paste in `firestore.rules` from this repo and Publish.
4. **Google Cloud → APIs & Services → Credentials:** restrict the Firebase browser key to HTTP referrers `https://nickjcowley.github.io/*` and `https://contacts-prompter.firebaseapp.com/*`.
5. **Gemini key:** create one in Google AI Studio on a project **with billing enabled** (paid tier – your notes aren't used to improve Google's products). Restrict it to the Generative Language API. Paste it into Settings in the app.
6. **GitHub → Settings → Pages:** deploy from the `main` branch, root folder.

On Android: open the site in Chrome → menu → *Add to Home screen* / *Install app*.

## Data model

`users/{uid}/people/{personId}`:

| field | type |
|---|---|
| `name`, `category` (Work/Social/Both), `summary` | string |
| `notes` | map of id → `{date, location, text, createdAt}` |
| `followUps` | map of id → `{text, done, createdAt, doneAt}` |
| `dates` | map of id → `{label, date ("YYYY-MM-DD" or "--MM-DD"), recurring}` |
| `links` | map of otherPersonId → `{label}` (both sides are written) |
| `contact` | optional copy of a phone contact `{name, tel[], email[], linkedAt}` |

Maps keyed by id (rather than arrays) mean edits made on two devices while offline merge cleanly instead of overwriting each other.

`users/{uid}/config/settings`: `{geminiApiKey, geminiModel}`.

## Deploying changes

With each release, bump `CACHE_NAME` in `sw.js` and the matching `?v=` numbers on `app.js` and `styles.css` in `index.html` and `sw.js`.

## Privacy note

This holds personal information about real people. When you use the AI, the note you dictate, plus a short summary of your existing contacts (names, summaries, open follow-ups, two most recent notes) so it can match names, is sent to Google's Gemini API. Write entries as if the person might one day read them.
