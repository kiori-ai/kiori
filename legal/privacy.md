# Kiori Privacy Policy

> **Beta version, not yet reviewed by a lawyer.** It describes what Kiori's code (version 2.0.0) actually does. We'll update it after a lawyer has reviewed it. The note in square brackets in section 10 is still to be completed with a lawyer.

**Effective date:** {{effective}}

## 1. Who we are

Kiori is run by **{{operator}}**, an individual founder based in {{country}}. Kiori isn't a company yet. In this policy, "Kiori", "we" and "us" mean {{operator}}.

- Contact: [{{email}}](mailto:{{email}})
- Postal address: {{address}}

Kiori is a brain service for character-AI products. Every AI character gets a **brain**: a JSON file with its memories, personality, relationships and who knows what. This policy covers our website (kiori.io), the API and console (api.kiori.io), the Kiori SDKs and the Kiori extension for SillyTavern. Kiori is in a free beta.

For the personal data described in section 3, we are the data controller under the EU's GDPR and Turkey's KVKK, where they apply. Section 7 explains when we act for a customer instead.

## 2. The short version

- **We don't store brains or chats.** You keep each brain and send it with every call. Calls that change it give it back. While a call runs, the brain and the messages are in our server's memory, and parts of them go to the model provider you chose. Then they're gone from our side.
- **We keep a little account data:** your access request, your project, a hash of each Kiori key, your model provider key in sealed (encrypted) form, counts and costs of your calls, and short notes about failed calls.
- **We don't sell data, show ads, or run analytics or tracking** on our pages.
- **Others do handle data:** Cloudflare carries all traffic to our site and API, and your model provider receives the text of each model call. Section 6 lists everyone involved.

## 3. What we keep

### When you ask for access

The form on kiori.io sends us your **email address** (required) and, if you fill them in, your **name**, your **company or project** and **what you're building**. We store these with the **IP address** the request came from and when you sent it.

A valid request is approved at once: it creates your project (below), and the page shows you a sign-in link to the console. If you send the form again with an email that already has a project, we don't store the new request and don't create a second project. While nobody has signed in to that project yet, the page shows a new sign-in link to it, and the earlier link stops working. Once someone has signed in, the form gives out no link for that email.

Requests sent before {{effective}} waited for us to approve or decline them. For those, we also keep whether and when we did.

### Your project

When your request is approved (at once, as described above), we create a project for you and keep:

- its ID and name (we start from your company, name or email, and you can rename it);
- a contact email (the one from your request);
- your model settings: the provider, its address, the model you picked and the embedding model;
- whether the project runs on your own model key or, if we agreed, on ours;
- when it was created.

### Your Kiori keys

A Kiori key (it starts with `kio_`) is shown once, when it's created. We keep only:

- a **one-way hash** of it (SHA-256), which lets us recognize the key but not read it;
- its **first 10 characters** (like `kio_AbC123`), so you can tell your keys apart;
- its label, when it was created, and when it was last used (to the minute).

We can't recover a lost key. Revoking a key deletes its record.

The access form shows you a **sign-in link** to the console. If you ask us for a new one, we may also send it by email. A sign-in link holds no key: it holds a one-time token, which we keep only as a one-way hash and which works once, within 7 days. When the link opens, the console makes a new Kiori key for that browser in exchange for the token, and we delete the token. Making a new link for a project cancels its earlier ones. Signing out of the console revokes that browser's key.

### Your model provider key (sealed)

Kiori does its model work with **your own key** from a model provider such as OpenRouter, OpenAI or Gemini.

- **"Sealed" means encrypted.** We encrypt the key with AES-256-GCM before writing it to our database, bound to your project so it can't be moved to another one. The secret that decrypts it is kept apart from the database, in a separate file or setting on our server, so a copy of the database alone doesn't reveal your key. Someone with full access to the server could decrypt it.
- Our server decrypts it only to make the model calls you ask for, to check the key when you save it, and to list the models it can use. It sends the key only to the provider it belongs to, over HTTPS.
- The console and the API only ever show its **last four characters**.
- When you remove or replace it, the old key is deleted from your project.

If you call the chat endpoint with a provider key in a request header (`X-Kiori-Upstream-Key`), we use that key for that request only and don't store it.

### Usage counts and costs

None of these records include what was said. We keep:

- for **each model call** Kiori makes on your key: the time, your project, what it was for (building a brain, learning from a chat, working out who was in each scene, checking a reply, memory upkeep, or an embedding), the model, the number of tokens in and out, and the cost your provider reported;
- for **API calls**: how many calls your project made to each endpoint each day.

We also look at these numbers in aggregate, for example how many projects are active each week.

### Notes about failed calls

When a call fails with a server error (status 500 or above), whether the problem is ours or your model provider's, we note the time, the project, the endpoint, the status and error code, and the model provider's status if the failure was theirs. **Never the content of the call.**

### IP addresses

- **Rate limits.** To stop abuse and key guessing, our server counts requests per IP address: access requests, calls with a wrong key, calls to endpoints that need no key, and failed admin sign-ins. These counters stay in the server's memory. They're never written to disk, and they're gone when the server restarts.
- **Access requests.** We store the IP address with each request (see above).
- Our server's own logs don't record IP addresses. Cloudflare does process them (section 6).

### Server logs

The server writes one log line per failed call (time, status, endpoint, error code, the model provider's status). The line has no IP address and no content. When something breaks unexpectedly, the server also logs the technical error message and where in our code it happened. **In rare cases, such an error message can include a few characters of the text being processed** (for example the start of a model's malformed answer).

### What your browser keeps

The console (api.kiori.io/console) keeps the Kiori keys you've signed in with in your browser's **local storage**, so you stay signed in. If an administrator signs in, their admin key is kept in **session storage** only, which the browser clears when the tab closes. Signing out removes the key from your browser. Our pages set **no cookies**.

## 4. What passes through but isn't stored

To do its work, Kiori receives, uses and hands back the following, without storing it:

- **brains**: memories, personality, relationships and state. A brain's memories quote the lines of chat they came from, so **a brain can contain personal data**;
- **chat messages**, with speaker names and your message IDs;
- **character cards** and descriptions;
- **player names**, and draft replies you ask us to check.

These are held in our server's memory only while your call runs. Depending on the call, parts of them go to your model provider:

| Call | What goes to your model provider |
|---|---|
| Create a brain | The card or description. A full brain takes three model calls, and then its memories are turned into embeddings. A light brain needs no model call. |
| Recall | The latest messages (or your query), at most 2,000 characters, to your provider's embedding model. No other model call. |
| Organize (learning) | Recent messages and parts of the brain. New memories go to the embedding model. In group chats, a call also works out who was in each scene, and a large brain occasionally gets a memory-upkeep call. |
| Check | The draft reply, recent messages and the relevant memories. |
| Chat endpoint (`/v1/chat/completions`) | Your whole chat request, with each character's mind added to the system prompt. The reply comes back through us, and a check may run on it first. |

Nothing from these calls is written to our database. The rare error-message fragment described under "Server logs" is the only exception in our logs. **We don't use any of it to train AI models.**

**With the SillyTavern extension,** your brains stay in your own SillyTavern files: in each chat's file, plus a character's freshly built brain in that character's card. If you share a character card, its brain goes with it.

## 5. Why we use data, and our legal basis

| What | Why | Legal basis |
|---|---|---|
| Access requests | To create your project and to write to you about it | Steps you asked for before a contract (GDPR Art. 6(1)(b); KVKK Art. 5(2)(c)) |
| IP address on an access request | To spot spam and abuse | Our legitimate interests (GDPR Art. 6(1)(f); KVKK Art. 5(2)(f)) |
| Project, keys, sealed model key | To run the service you signed up for | Contract (GDPR Art. 6(1)(b); KVKK Art. 5(2)(c)) |
| Usage counts and costs | To show you your usage, and to understand and improve Kiori | Contract; our legitimate interests |
| Failed-call notes and server logs | To find and fix problems | Our legitimate interests |
| IP addresses for rate limits | To protect the service and your keys | Our legitimate interests |
| Brains, chats and cards passing through | To do what each call asks | For platforms, on the platform's behalf (section 7). For individuals, contract |
| Fonts loaded from Google | To show the site's typefaces | Our legitimate interests |

We don't make decisions about you based only on automated processing.

## 6. Who else handles data

We don't sell personal data, and we don't share it for advertising.

| Who | What for | What they see |
|---|---|---|
| **Cloudflare** | Serves kiori.io (Cloudflare Pages), and carries every request for api.kiori.io to our server through an encrypted tunnel | All traffic in transit, including IP addresses, keys, brains and chats (Cloudflare decrypts HTTPS at its network edge) |
| **Your model provider** (OpenRouter, OpenAI, Google Gemini, or another OpenAI-compatible provider you choose) | The model work for your calls, under your own account and its terms | The text of each model call (section 4) |
| **Our hosting provider**, {{hosting}} | Runs our server and database, and keeps a daily image of the server as a backup | Everything we store, and content in memory while calls run |
| **Google** (Google Fonts) | Fonts on kiori.io and the console | Your IP address and browser details, when a page loads the fonts |
| **Our email providers**: {{mail}} | Our mailbox ({{email}}): support, and sign-in links we send when you ask for a new one | Your email address and what we write to each other |
| **Authorities** | Only when the law requires it | What the law requires |

**About model providers:**

- Whether a provider keeps, logs or trains on what it receives depends on its terms and **your account settings** with it, not on us. Please check them.
- **On OpenRouter**, Kiori asks for the fastest available host of your chosen model, so OpenRouter may pass a call to any company that serves that model, in any country. When your chosen model keeps failing or answering badly, Kiori makes **one last attempt with a fallback model** (currently DeepSeek V4.1 Flash) through your OpenRouter account. Embeddings on OpenRouter use OpenAI's text-embedding-3-small model.
- If we agree to run a project on **our own model key**, its model calls go to our provider (OpenRouter by default), under our account.

## 7. Our role: controller or processor

- **Your account data** (sections 3 and 5): we decide how it's used, so we're the **controller**.
- **Platforms:** when a business uses Kiori for its own users, the business decides what to send and why. For the brains, messages, names and cards in those calls, **the business is the controller and Kiori is its processor.** We use them only to carry out each call, on the business's behalf, under our Terms. If you use such a platform, its privacy policy covers your chats, so please send requests about them to the platform. If such a request reaches us, we'll pass it on.
- **Individuals:** if you use Kiori for yourself, for example with the SillyTavern extension, we're the controller for what we process for you, as this policy describes.

## 8. How long we keep things

| What | How long |
|---|---|
| Brains, chats, cards, player names | Not kept. They're only in memory while a call runs. |
| Access requests, including the IP address | Until we delete them. Deletion is manual for now: ask us and we will. |
| Your project and its settings | While the project exists. Deletion is manual for now: ask us and we will. |
| Kiori key records | Until you revoke the key or the project is deleted |
| Your sealed model key | Until you remove or replace it, or the project is deleted |
| Usage counts and costs | No automatic deletion yet. Kept until we delete them along with the project. |
| Notes about failed calls | 30 days. Notes older than that are deleted each time a new failure is noted. |
| Server logs | {{logs}} |
| Rate-limit counters | In memory only, until the server restarts |
| Backups | {{backups}} Something deleted from our database stays in the backups until they're replaced. |
| Keys in your browser | Until you sign out or clear your browser's storage |

## 9. Security

- Connections to kiori.io and api.kiori.io use HTTPS. Cloudflare passes API traffic to our server through an encrypted tunnel. The server doesn't accept connections from the internet directly.
- Our server calls model providers over HTTPS only.
- Kiori keys are stored only as hashes, and model keys are sealed (section 3).
- Every project has a rate limit. Calls with a wrong key and failed admin sign-ins are rate-limited per IP address.
- Only {{operator}} has access to the server and the database.

No system is perfectly secure. If a breach affects your personal data, we'll tell you, and the authorities, as the law requires.

## 10. Where your data is handled

We run Kiori from {{country}}. Our server is with {{hosting}}. Cloudflare works through data centers around the world. Model providers such as OpenRouter, OpenAI and Google, and Google Fonts, are based mainly in the United States, and OpenRouter may pass calls to companies in other countries. So your data may be handled outside your own country. Where the law requires a safeguard for these transfers, we use [to be completed with a lawyer: the safeguards for these transfers, for example the European Commission's standard contractual clauses and the KVKK Board's standard contracts].

## 11. Your rights

Depending on where you live, data protection law (such as the GDPR or KVKK) gives you the right to:

- find out whether we hold personal data about you, see it, and get a copy in a common format;
- learn why we use it and who we've shared it with, in your country or abroad;
- have it corrected or deleted, and have anyone who received it told;
- object to how we use it, or ask us to limit it;
- complain, and claim compensation where the law allows.

**Things you can do yourself:**

- See your project, keys and usage in the console, or with `GET /v1/project` and `GET /v1/usage`.
- Revoke Kiori keys and remove or replace your model key, in the console or through the API.
- Your brains are already with you. `POST /v1/brains/export` turns one into an Obsidian vault.

**Ask us** at [{{email}}](mailto:{{email}}) for anything else, such as deleting your project and account data. We'll answer as soon as we can, within the deadline the law sets (one month under the GDPR, 30 days under KVKK). We may ask you to show that the request is yours, for example by writing from the project's contact email.

**Complaints:** you can complain to a data protection authority, in particular where you live or work. In Turkey, write to us first. If you're not satisfied with our answer, you can then complain to the Personal Data Protection Authority (KVKK).

**If you're an end user of a platform** that uses Kiori, the platform holds your brains and chats, so ask the platform first (section 7).

## 12. Children

Kiori is for businesses and developers, and you must be 18 or older to use it. We don't knowingly collect personal data from children. Platforms that use Kiori are responsible for their own users' ages and for any consent the law requires (see our [Terms](/terms)). If you think a child has sent us personal data, write to us and we'll delete it.

## 13. Changes

We'll update this policy as Kiori changes, for example when the beta ends or Kiori becomes a company. We'll post the new version here with a new effective date. For important changes, we'll email customers before the changes take effect.

## 14. Contact

{{operator}} · [{{email}}](mailto:{{email}})
{{address}}
