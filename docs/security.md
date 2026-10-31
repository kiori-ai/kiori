# Security

Kiori holds very little, on purpose: no brains, no chats, and one key of yours that it guards closely. This page says exactly what Kiori keeps, how your keys are protected, and what you can do on your side.

## What Kiori keeps

| Kept | What exactly |
|---|---|
| Your project | Its name, a contact email, and your model settings: the provider, the model, and your brain API key, sealed (see below). |
| Your Kiori keys | A SHA-256 hash of each key, its first ten characters, its label, when it was made and when it was last used (to the minute). Never the key itself. |
| Sign-in links | A hash of each link's one-time token, until it's used or runs out (7 days). |
| Your access request | Your email, and the name, company and use case you wrote, with the address it came from. |
| Usage | Counts: calls per endpoint per day, and for each model call Kiori made on your key, what it was for, the model, the tokens and the cost. |
| Failed calls | For a call that failed on our side: when, which endpoint, the status and its code, and your provider's status. Kept 30 days. |

The [privacy policy](/privacy) says the rest: who else handles data, how long each thing is kept, and your rights.

**Never kept:** brains, chats, messages, prompts, or anything a model wrote. A brain and its messages are in our server's memory while a call runs, parts of them go to your model provider in Kiori's prompts, and then they're gone from our side.

## Your brain API key

Kiori does its thinking on your model provider key, so that key gets the most care:

- **Sealed before it's stored.** AES-256-GCM, with a sealing key made (HKDF-SHA256) from a secret kept apart from the database: a copy of the database alone opens nothing. Each sealed key is also bound to its project and setting, so it can't be lifted into another project. The secret can be replaced at any time, and every key is then sealed again with the new one.
- **Never shown back.** Not to you, not in the console: only its provider and last four characters. To change it, paste a new one; to remove it, `PATCH /v1/project` with `{ "llm": null }`.
- **Only sent to its own provider.** That's the provider Kiori recognized from the key (OpenRouter, OpenAI or Gemini), or the https address you saved it with. Change the address without sending the key again, and the key is dropped rather than carried along. The drop-in never sends it to an address a request names: a request that wants another provider brings its own key.
- **Over checked connections.** Calls to your provider go over https, and the address is checked when it's looked up for the connection itself: it must be on the public internet, never our own server, a private network or a cloud's metadata address. The address ends at its path (no `?` or `#` part), so calls only reach the API's own paths under it. A provider's redirect is never followed.
- **Blanked out of errors.** If a provider's error ever says a key back, Kiori replaces it with `[key]` before passing the error on or noting it.

On your side, the best protection is simple: **give Kiori a key of its own, with a spending limit at your provider** (OpenRouter lets you set a credit limit on each key; OpenAI, a budget for each project). Then even a mistake can only spend so much, and you can replace that one key without touching anything else.

## Your Kiori keys

- Each key is 24 random bytes. Kiori stores only its hash, so a key is shown once, when it's made. Lost one? Make a new one and revoke the old.
- Revoke a key any time in the console (or `DELETE /v1/project/keys/:prefix`); it stops working at once. The console shows when each key was last used.
- Keep Kiori keys on your server. In a browser, a key is fine only when the person using the page owns it, as with your own key in the SillyTavern extension.
- Calls are limited per project (1200 a minute, and 64 model calls at once), so a runaway loop, or a leaked key, can't spend much before you notice.
- The keys your app uses can't change the project: its brain API key, its provider address and its Kiori keys change only with an owner key, the one the console makes when you sign in with your link. A key that leaks from your app can't send your calls elsewhere.

## Sign-in links

A sign-in link holds **no key**: it holds a one-time token, good for 7 days and kept by Kiori only as a hash. When the link opens, the console trades the token for a Kiori key of that browser's own, and the token is gone; a link that leaks from a mailbox later opens nothing. Signing out of the console revokes that browser's key.

## The console

The console keeps your Kiori keys in your browser's local storage and talks to the API directly. Its page lets only its own script run (a Content-Security-Policy made from the page itself), sends no referrer, and can't be framed by another site.

## On the wire

- Your calls reach Kiori over HTTPS, through Cloudflare. Kiori's calls to your model provider go over HTTPS too.
- Answers from the API aren't cached along the way (`Cache-Control: no-store`), and carry the usual protective headers.
- Keys and sign-in links are 192 random bits, far too many to guess. Wrong keys, access requests and sign-ins are rate-limited per address all the same, and the forms can't be flooded.

## What your model provider sees

Kiori's model work goes to the provider of your brain API key, under your account with them: the text of each model call (parts of the brain and of the chat, in Kiori's prompts) and the texts it makes meaning fingerprints of. Their terms and data settings apply, so check them for training and retention.

## Reporting a problem

Found something that looks like a vulnerability? Write to [help@kiori.io](mailto:help@kiori.io) with "security" in the subject. Please give us a chance to fix it before telling others, and don't touch anyone else's project while looking. We'll answer quickly, and thank you by name if you like.
