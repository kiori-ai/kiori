# Kiori for SillyTavern

**Give every character a brain.** With this extension, each character in your SillyTavern chats gets a mind of their own: a past and a personality from their card, the people in their life, what happened in this chat, and a strict sense of what they could possibly know. Before each reply, what the character knows right now goes into the prompt. After it, the brain learns from the chat.

- **A brain per character, per chat.** It's built from the character's card the first time you talk, kept in the chat's own file, and grows after every reply.
- **New chats start clean.** The brain first built from a card is also kept on the card, so every new chat with that character starts from it instead of building again, and what one chat taught never leaks into another.
- **Group chats.** Every member gets a brain, and each one learns only the scenes they were in.
- **Edits, swipes and deletions are noticed.** What they taught is unlearned.
- **Secrets stay with whoever heard them.** Each reply is checked against what its speaker could know. A character who names something they never witnessed is marked, or fixed.

You need a Kiori key. Ask for access on [kiori.io](https://kiori.io/#access); then, in the console, paste your brain API key (OpenRouter, OpenAI or Gemini) and create a Kiori key.

## Install

### By URL (recommended)

SillyTavern installs extensions from a Git repository, so the machine running SillyTavern needs [git](https://git-scm.com/downloads).

1. In SillyTavern, open **Extensions** (the cubes icon in the top bar) and click **Install extension**.
2. Paste this address and leave the branch empty:

   ```
   https://github.com/kiori-ai/SillyTavern-Kiori
   ```

3. Click **Install just for me**, or **Install for all users** if you're the admin of a SillyTavern with several users.
4. If the **Kiori** drawer doesn't show up under Extensions, reload the page.

To update, open **Extensions**, then **Manage extensions**, and click the update button next to Kiori. Turn on **Notify on extension updates** to hear about new versions.

### From the zip

1. Download `kiori-sillytavern.zip` from your Kiori console, or from [api.kiori.io/sillytavern.zip](https://api.kiori.io/sillytavern.zip).
2. Unzip it into `SillyTavern/data/default-user/extensions/` (if you have several users, use your user's folder instead of `default-user`). You get a folder named `kiori` with `manifest.json` inside.
3. Reload SillyTavern.

A zip install doesn't update itself. To update, replace the `kiori` folder with a fresh download.

Use one install or the other, not both: two copies would both run on every message. To switch from the zip to the URL install, delete the `kiori` folder first. Your key, your settings and your brains are kept either way.

## Settings

Open **Extensions** and expand **Kiori**.

| Setting | What it does |
|---|---|
| Give characters a brain | Turns Kiori on or off. |
| Kiori key | The key from your Kiori console (`kio_...`). |
| Kiori address | Where Kiori runs, `https://api.kiori.io`. Change it only if you run your own Kiori. |
| New brains | **Full**: a whole past written from the card (about a minute, and about a cent on your brain API key). **Light**: from the card alone, free and at once; the chat teaches it the rest. |
| Memory per reply | The most Kiori adds to the prompt for each reply, in characters: 800 to 20,000, 4,000 by default. In a group chat, each character gets a share of it (at least 800). |
| Check replies | **Fast** (the default): the free pre-check marks what a character couldn't know. **Full**: the auditor also fixes it, about $0.001 a reply. **Off**: no check. See [Leak check](#leak-check). |

Under the settings, the status shows each character's brain in the open chat: how many memories it has, and the last message it learned from.

- **Learn now** learns from this chat right away, newest messages included. Otherwise learning waits until about 12 new messages have settled, and the newest 4 wait in case you swipe or edit them.
- **Forget this chat** drops what this chat taught its characters. They start again from their card's brain.

## Leak check

Your chat model sees the whole chat, so it can make a character say something they were never there for: a name only another character heard, a secret from a scene they missed. After each reply (a swipe or a continue too), Kiori checks it against what the speaker could know. The chat never waits for it.

- **Fast** (the default) runs Kiori's own pre-check: free, no model call, in a moment. When the reply has a name or a number that only another character's brain holds, a small mark appears under it, such as *Kiori: Rook couldn't know "Marisol"*. Click **ask the auditor** on the mark to run the full check on that reply alone and put its fix in place.
- **Full** runs the pre-check and then the auditor on every reply, about $0.001 a reply on your brain API key. When the auditor finds a leak, a contradiction or a past the character doesn't have, it rewrites only the words that slipped, and the fixed reply takes the place of the one written, in the chat file too, so the brains learn from it. A mark says *Kiori fixed this*; hover it to see the reply as it was.
- A character keeping up a lie isn't a mistake: it gets a small *keeping up a lie* mark and is never changed.
- If a check fails, the reply stays as it is.

The pre-check works best in group chats, where there are other brains to compare with. To turn checks off, choose **Off** under **Check replies**; turning Kiori off turns them off too.

## Privacy

- **Brains stay in your chat files.** Each chat's brains are saved in that chat's file, in your SillyTavern data folder. The brain first built from a card is also saved on the character card, so exporting or sharing the card includes it. That brain holds only what was built from the card, never your chats.
- **Kiori stores no brains and no chats.** To build a brain, the extension sends the character's card (in a group, with the other members' names) to the Kiori address in your settings. Before a reply, it sends the brains, your persona's name and the last 12 messages; to check a reply, the brains, the reply and the 40 messages before it; to learn, the brains with the last 60 messages. Hidden messages are never sent. Kiori uses what it gets to answer, then keeps none of it. What Kiori does keep is your account: your keys, usage counts, and, for 30 days, a note of each call that failed on its side (which endpoint, the status and the error code, never what was said).
- **Model work runs on your brain API key.** Building, learning and full checks call the model provider whose key you put in your Kiori console, so that provider sees the text it works on, under its own terms.
- **Your Kiori key** is saved in SillyTavern's settings on the machine running SillyTavern, in plain text like other extension settings.
- **The rest** is in the [privacy policy](https://kiori.io/privacy). Using Kiori means you accept the [beta terms](https://kiori.io/terms).

## Troubleshooting

| What you see | What to do |
|---|---|
| Nothing happens, and the status says "Paste your Kiori key to start." | Paste your key in the Kiori settings. |
| "Building …'s brain (about a minute)…", and the first reply waits | A full brain is being built, once per character. Choose **Light** under New brains for instant brains. |
| "No memories this time: can't reach Kiori at …" | Check the Kiori address and your connection. The extension has already asked again twice. |
| "No memories this time: A valid API key is required …" | The key is wrong or was revoked. Create a new one in your Kiori console. |
| "… no brain API key yet …", "… refused your key …" or "… out of credits" | Kiori builds and learns on the model provider key in your Kiori console: add it there, check it, or top up your credits with that provider. |
| "Replies aren't checked: … no brain API key yet …" | Full checks run on the brain API key in your Kiori console. Add one there, or choose **Fast** under **Check replies**, which needs none. |
| Characters don't remember the last few messages yet | Learning waits until about 12 new messages have settled, and the newest 4 wait for swipes and edits. Press **Learn now** to learn right away; "Nothing new to learn yet." means everything is learned already. |
| **Install extension** fails | Paste the repository address above, not the zip's address. Make sure git is installed on the machine running SillyTavern. If a folder with the same name is already in your extensions folder, delete it first. |
| Two Kiori drawers, or every Kiori notice shows up twice | Both the zip and the URL install are there. Delete one (in **Manage extensions**, or delete its folder) and reload. |
| No Kiori drawer at all | Reload the page, and check in **Manage extensions** that Kiori is enabled. The browser console (F12) shows the extension's messages, which start with `[Kiori]`. |

More about how brains work: [kiori.io/docs](https://kiori.io/docs).

## License

MIT. The full text is in [LICENSE](LICENSE).
