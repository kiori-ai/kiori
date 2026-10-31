# Kiori Beta Terms

> **Beta version, not yet reviewed by a lawyer.** It's written from what Kiori's code (version 2.0.0) does. We'll update it after a lawyer has reviewed it. The note in square brackets in section 8 is still to be completed with a lawyer.

**Effective date:** {{effective}}

These terms are an agreement between you and **{{operator}}**, an individual based in {{country}} who runs Kiori. Kiori isn't a company yet. Here, "Kiori", "we" and "us" mean {{operator}}. The terms cover the Kiori API and console (api.kiori.io), the SDKs, the SillyTavern extension and the site kiori.io (together, "the Service").

By asking for access, creating a key or calling the API, you accept these terms and our [Privacy Policy](/privacy). If you use Kiori on behalf of a company, you confirm that you may accept these terms for it, and "you" then means that company. You must be at least 18 years old.

## 1. The beta

- Kiori is in a **free beta**. A valid access request gets its project at once. We may turn requests away, for example to stop abuse, and section 10 says when we may suspend access.
- Anything can change during the beta, including features, endpoints, limits and the brain format. We'll try to warn you before changes that break your integration.
- The beta will end. Before it does, we'll offer you either new terms, which may include fees, or a way out.

## 2. Price

- Kiori is **free during the beta.** We won't charge you without your agreement, and we'll tell you at least 30 days before any fee would apply to you.
- Any prices shown on kiori.io are a preview, not an offer.
- **Your model provider bills you directly** for the model work Kiori does on your key: building brains, learning, working out who was in each scene, checks, memory upkeep and embeddings. That includes calls Kiori repeats when a model answers badly or a provider is briefly down, and, on OpenRouter, one last attempt on a fallback model. Our cost figures are estimates. We're not responsible for your provider's charges.
- If we agree to run your project on our own model key, we pay for that model work and may limit it.

## 3. No warranty, no SLA

- The Service is provided **"as is" and "as available"**, without warranties of any kind, as far as the law allows.
- There is **no service level agreement**: no promised uptime, speed or support. The Service runs on a single server. It may be slow, interrupted or unavailable, for example during maintenance or a move between servers.
- **We don't keep your brains.** If you lose one, we can't restore it, so back them up yourself. Calls that change a brain return a new version, which may have faded or forgotten memories, or may have unlearned what an edited message taught it. Keep the old version if you might need it.
- **AI output can be wrong.** Brains, recall, learning and checks come from AI models. They can be inaccurate or inconsistent, and a check can miss a leak. **Kiori doesn't filter or moderate content.**
- SillyTavern is an independent open-source project. We're not responsible for it.

## 4. Keys

- **Keep your Kiori keys and sign-in links secret.** Put your Kiori key on your server, never in an app or web page that other people use. A key in an app is fine only when the person using the app owns the key, as with your own key in the SillyTavern extension.
- You're responsible for everything done with your keys. If a key may have leaked, revoke it in the console, create a new one, and tell us about any misuse.
- We keep only a hash of each Kiori key, so we can't show you a key again.
- You confirm that you may use your model provider key with Kiori. We keep it sealed and use it only for the work you ask for (see the Privacy Policy).

## 5. Acceptable use

Don't use Kiori to:

- break the law, or help anyone else break it;
- create sexual content involving minors, including any character who is, or is presented as, under 18. If we learn of such content, we'll end your access and report it where the law requires;
- harass, threaten, defame or exploit anyone, build a brain that imitates a real, living private person without their consent, or sexualize real people;
- infringe anyone's intellectual property, privacy or other rights, or send personal data you have no right to send;
- spread malware; attack, probe or overload the Service; get around rate limits or other limits (for example with extra keys or projects); try to reach other customers' data; or reverse-engineer the Service except where the law allows it;
- resell or pass on raw access to the Service without our written permission (building Kiori into your own product is fine);
- make decisions about real people's rights, money, health, jobs or access to services.

### Rate limits

Today's limits are:

- 1,200 calls a minute per project;
- 60 calls a minute with a wrong key, per IP address;
- 120 calls a minute per IP address to endpoints that need no key;
- 5 access requests an hour per IP address;
- requests of up to 1 MB, 12 MB to create a brain, and 24 MB for calls that carry brains.

We may change these limits at any time. A call over a rate limit gets a `429` answer, and a request that's too big gets a `413`.

## 6. Your responsibilities

- **Your model provider.** You choose it, and you follow its terms and usage policies, including its content rules. Whether it keeps or trains on what it receives depends on its terms and your account settings.
- **Your end users.** If you run a platform, you're responsible for it and its users. That includes telling them about Kiori and your model provider in your privacy policy, having a legal basis for their data, answering their requests (you hold their brains; we don't), telling them they're talking to an AI where the law requires it, and moderating what they create.
- **Adult content.** If your platform allows adult content, you must keep it to adults: check ages as the law and your platform's policies require, and follow your model provider's rules. The ban in section 5 on sexual content involving minors always applies.
- **Children.** Kiori isn't made for children. If your platform allows users under 18, you're responsible for age-appropriate design and for any parental consent the law requires.
- **Brains.** You store them, protect them and back them up, and you delete them when they should be deleted, for example when an end user asks.
- **Your content.** You need the rights to everything you send, including character cards and lorebooks.

## 7. Your content and ours

- **Yours stays yours.** Your character cards, chats and brains belong to you or your end users. You let us use them only to carry out the calls you make. We don't keep them, and we don't train AI models on them.
- **Ours stays ours.** The Service, its software, the Average Human Model and the brain format belong to us. During the beta you may use the Service to build and run your product. The SDKs and the SillyTavern extension are open source under the MIT License. That license governs their code, and these terms govern your use of the Service through them.
- **Feedback.** If you send us ideas or feedback, we may use them freely.

## 8. Your end users' personal data (processor terms)

When you send personal data about your end users, **you're the controller and we're your processor.** Until a separate data processing agreement exists, this section is our agreement about that data:

- **What and why.** The data is chat messages, names, character data and brains. It can include any personal data your users put in their chats, including sensitive data, about your end users and anyone they mention. We process it only to carry out your calls, for as long as you use the Service.
- **Your instructions.** Your API calls and settings are your instructions. We'll tell you if we think an instruction breaks the law.
- **No storage.** We keep the data only in memory while a call runs (apart from the rare error-message fragment the Privacy Policy describes), so when you stop using Kiori there's nothing to return or delete.
- **Confidentiality and security.** Only {{operator}} can access the Service's systems. Anyone who helps later will be bound to confidentiality. The Privacy Policy describes our security measures.
- **Sub-processors.** You allow us to use Cloudflare and our hosting provider, {{hosting}}. Your model provider works under your own account with it. We'll tell you at least 14 days before adding or replacing a sub-processor. If you object, you can stop using the Service.
- **Transfers.** We run Kiori from {{country}}, and our sub-processors may handle data in other countries (see the Privacy Policy). [To be completed with a lawyer: the safeguards for these transfers, for example standard contractual clauses for customers in the EU.]
- **Help.** We'll pass on any requests from your end users that reach us. Where we reasonably can, we'll help you answer those requests and meet your duties on security, breaches and impact assessments. We'll tell you without undue delay if we learn of a breach affecting their data.
- **Proof.** We'll give you the information you reasonably need to show that these terms are met.

## 9. Liability

- As far as the law allows, we're not liable for indirect or consequential losses, lost profits, revenue, data or goodwill, or for your model provider's charges.
- As far as the law allows, our total liability for everything related to the Service is limited to EUR 100.
- Nothing in these terms limits liability that the law doesn't allow to be limited, such as liability for intent, gross negligence, death or personal injury. Nothing in these terms takes away your rights as a consumer.

**Your part:** if someone brings a claim against us because of your content, your platform or your end users, or because you broke these terms or your model provider's terms, you'll cover our reasonable losses and costs from it, as far as the law allows.

## 10. Suspension and ending

- You can stop using Kiori at any time. To close your project and have its data deleted, write to [{{email}}](mailto:{{email}}).
- We can suspend or revoke your keys or your project, with notice when we reasonably can, if you break these terms, if your use puts the Service, other customers or anyone else at risk, if the law requires it, or if we end the beta or the Service.
- When your access ends, your right to use the Service ends. You keep your brains, since they were always with you. We delete your account data as the Privacy Policy describes.

## 11. Changes

We may change these terms. We'll email you at least 14 days before an important change takes effect, unless the change is needed sooner for legal or security reasons. If you keep using Kiori after that, the new terms apply. If you don't agree, stop using it.

## 12. Governing law

These terms are governed by the laws of {{law}}, and the courts of {{courts}} decide disputes. If you're a consumer, you keep the protection of the mandatory laws of the country where you live.

## 13. General

- These terms and the Privacy Policy are the whole agreement about the beta.
- If part of these terms can't be enforced, the rest still applies.
- If we don't enforce a right right away, we haven't given it up.
- You can't transfer these terms without our consent. We may transfer them, for example to a company that takes over Kiori, and we'll tell you first.
- Neither of us is responsible for failures caused by events beyond our reasonable control.

## 14. Contact

{{operator}} · [{{email}}](mailto:{{email}})
{{address}}
