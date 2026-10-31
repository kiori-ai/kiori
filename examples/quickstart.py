# End to end: build two brains, play a short scene where only one of them hears a secret, let them learn, then ask
# each what they know and let the auditor catch a leak. Kiori keeps no brains: they live in this script.
# Install: pip install kiori-ai
# Usage: KIORI_API_KEY=kio_... python3 examples/quickstart.py   (spends a few cents on your brain API key)
# Inside this repo, without installing: PYTHONPATH=sdk python3 examples/quickstart.py
import json
import os
from concurrent.futures import ThreadPoolExecutor

from kiori import Kiori

kiori = Kiori(os.environ.get("KIORI_API_KEY"), **({"base_url": os.environ["KIORI_URL"]} if os.environ.get("KIORI_URL") else {}))

print("Building Mira and Tom...")
with ThreadPoolExecutor() as pool:   # both at once: a full brain takes about a minute
    mira, tom = pool.map(lambda c: kiori.create(**c), [
        {"name": "Mira", "pronouns": "she", "description": "Lighthouse keeper on a cold island, ex-war medic, dry humor, hates being pitied, keeps a box of letters she never sent.", "others": ["Tom"]},
        {"name": "Tom", "pronouns": "he", "description": "The island ferryman, gossip, kind, terrible at keeping secrets, owes Mira for saving his son.", "others": ["Mira"]},
    ])

# The chat as your app has it. Who was there is given here; leave "present" out and Kiori works it out.
messages = [
    {"id": "1", "role": "narrator", "content": "*The ferry docks in the storm. Tom ties the rope while Leo climbs onto the pier.*", "present": ["Tom", "Leo"]},
    {"id": "2", "role": "assistant", "name": "Tom", "content": "Lighthouse is up the hill. Mira doesn't like visitors, but she won't let you drown.", "present": ["Tom", "Leo"]},
    {"id": "3", "role": "narrator", "content": "*Leo climbs alone to the lighthouse. Mira opens the door, sees him soaked, and lets him in without a word.*", "present": ["Mira", "Leo"]},
    {"id": "4", "role": "user", "content": "I have to tell someone. I'm not a tourist. I'm the son of the man who sank the Halcyon.", "present": ["Mira", "Leo"]},
    {"id": "5", "role": "assistant", "name": "Mira", "content": "The Halcyon. Forty-one people. *she sets the kettle down too hard* Then you'd better never say that name in town. Especially not to Tom.", "present": ["Mira", "Leo"]},
]
print("Learning...")
r = kiori.organize(brains=[mira, tom], messages=messages, player="Leo", now=True, hold=0)
mira, tom = r["brains"]   # keep the brains that come back
print("\n".join("  %s: %s messages, %s written, dropped %s" % (l["name"], l["messages"], l["written"], json.dumps(l["dropped"])) for l in r["learned"]))

characters = kiori.recall(brains=[mira, tom], query="Leo's father, the Halcyon", player="Leo")["characters"]
for c in characters:
    print("\n--- What %s brings to the moment ---\n%s" % (c["name"], c["text"][:1200]))

print("\nChecking a draft where Tom knows what he shouldn't...")
verdict = kiori.check(brains=[mira, tom], messages=messages, player="Leo", draft="Tom: Morning, Leo. Shame about your father and the Halcyon, eh? Mira told me everything.")
print(json.dumps(verdict, indent=2))
