# Ember protocol (v2)

Desktop and mobile run byte-identical protocol code (`desktop/src/{protocol,discovery,dm}.js`,
mirrored to `mobile/worklet/*.mjs` by `tools/sync-shared.js`). This is what
they say to each other.

## Identity and feeds
- An identity is a Hypercore v11 keypair held by Corestore.
- **`author`** = the core key (hex). In Hypercore v11 this is a manifest hash,
  not a signing key.
- **`edpk`** = the Ed25519 signer public key (hex). It is published in the
  author's own `profile` block as `dmKey`, which ties it to `author`.
- A feed is an append-only log of JSON blocks:

| type | fields |
|---|---|
| `post` | `text`, `ts`, optional `mediaSeq` + `thumb`, or `videoMeta {start,count,mime,size}` |
| `quote` | as post, plus `ref {author, seq}` |
| `reply` | `text`, `ref {author, seq}`, `ts` |
| `repost` | `ref {author, seq}`, `ts` |
| `media` | `data` (image data URL), `ts` |
| `vchunk` | `d` (base64 slice of an mp4; `videoMeta` points at the run) |
| `story` | `data` (image data URL), `caption`, `ts` (shown for 24h) |
| `profile` | `name`, `status`, `bio`, `avatar`, `dmKey`, `ts` (later fields win, missing fields fall back to older blocks) |
| `follow` / `unfollow` | `key` |
| `delete` | `ref {seq}`: tombstone; the target block is then cleared |
| `modlist` | `keys` (≤ 5000 author keys), `ts`: the author's published blocklist; the newest one replaces older ones, an empty list retracts it |

Readers must sanitize every block (`sanitizeBlock`) and tolerate holes:
cleared blocks are skipped, never waited on.

## Swarms (Hyperswarm topics)
| layer | topic |
|---|---|
| feed replication | the core's `discoveryKey` |
| discovery bucket | `sha256("ember/v1/disc/{table}/{code}")` |
| topic room | `sha256("ember/v1/topic/{id}")`, `id` from the shared catalog (`desktop/src/topics.json`) |
| commons bucket | `sha256("ember/v1/commons")` |
| reply thread | `sha256("ember/v1/replies/{author}/{seq}")` |
| DM inbox | `sha256("ember/v1/dm/{author}")` |
| nearby area (opt-in) | `sha256("ember/v1/area/{grid}:{row}:{col}")`, on a dedicated swarm |

Gossip and DM connections speak newline-delimited JSON. Each connection is
rate-limited (burst 60, refill 20 msg/s). Both sides speak first (`hello` /
`dmhello`, or a near card on the area swarm); a connection that stays silent
for 6 s (4 s on the area swarm) is closed, since the other side has already
dropped it.

## Discovery (LSH)
Text → 256-dim feature-hashed embedding (words, 4-char stems, bigrams, char
3/4-grams; EN+FR stopwords down-weighted) → 8 tables × 4 sign bits against
hyperplanes derived from the seed `ember/v1/lsh` → 8 bucket topics. Clients
join the buckets of what they write and read; queries also probe 1-bit-flip
neighbours. Results are re-ranked by `0.78·cosine + 0.22·recency`.

**Topic rooms.** LSH buckets are coarse, so a short post and a topic's seed
words rarely share one. Topics therefore have named rooms. A client sits in
the rooms of the topics its user picked, and a post is also sent into the
rooms of the topics it is recognised as being about (seed words in EN, FR,
ZH, AR; Arabic words are normalised and their article stripped), at most two
per post. A client with topics also sits in two **decoy** rooms: the first two
unpicked topics when the catalog is ordered by `sha256("{secret}:{id}")`, with
a secret that never leaves the device. They are as stable as real picks. With topics picked, the commons bucket is only joined
while the client has fewer than 3 gossip peers (left again at 6).

**Compass (local only).** A decaying vector (≈3-week time constant) learned
from the user's own actions, blended with the picked topics' seed words in the
languages they read. It sits the client in the buckets of its own codes, plus
1-, 2-bit and opposite-corner neighbours as the FAMILIAR ↔ STRANGE dial turns.
Discover lines posts up by closeness to it and the dial keeps one band of that
line (closest 40 %, closest 70 %, furthest 70 %, furthest 40 %; at least 6
posts), shown newest first.
Nothing about the compass is sent; what peers can see is which buckets and
rooms the client joins.

## Gossip messages
| message | meaning |
|---|---|
| `{t:'hello', since}` | sent on connect; peer replies with announcements newer than `since` |
| `{t:'ann', a}` | an announcement (below) |
| `{t:'del', a:{author, seq, ts, edpk, sig}}` | signed tombstone |

Announcement `a`: `author, seq, ts, text, kind ('post'|'quote'|'reply'), ref, edpk, sig, sig2`, optional `thumb, mediaSeq, videoMeta`.

A client does not relay (nor offer in `hello` replies) announcements from
authors it muted or that its subscribed blocklists hide, except its own.

## Signatures (Ed25519 over UTF-8 strings)
```
v1   = "{author}|{seq}|{ts}|{sha256(text)}"
v2   = "ember/ann/2|{v1}|{sha256(kind|ref|sha256(thumb)|mediaSeq|videoMeta)}"
del  = "ember/del/1|{author}|{seq}|{ts}"
dm   = "ember/dm-proof/1|{challenge}|{author}"
fire = "ember/fire/1|{fire}|{author}|{edpk}|{name}|{ts}|{sha256(text)}"
```
Receivers drop an announcement whose `sig` fails, or whose `sig2` is present
and fails. Media fields are kept only when bound by `sig2` (or when the
announcement is openly unsigned and shown as UNVERIFIED). A delete is applied
only if signed by the key already tied to `author`.

## Nearby (opt-in)
A **near card** announces an identity on the local network or in an area:
```
{ via: 'lan'|'area'|'bye', key, edpk, name, ts, sig, [place, lat, lon] }   // place/lat/lon only for 'area'
near = "ember/near/1|{via}|{key}|{edpk}|{name}|{place}|{lat}|{lon}|{ts}"   // place/lat/lon empty otherwise
```
`sig` is Ed25519 over `near` with the identity's signer key. Receivers drop
cards that fail to verify, are more than 10 minutes off, carry `|` or control
characters in `name`/`place`, or give `lat`/`lon` finer than 0.01° (a town
centre). A card whose `edpk` differs from the key published in the author's
profile is an impersonation and is dropped; a card from an author whose profile
hasn't replicated yet is shown as unconfirmed. A `bye` card, sent on the
channel being left when someone hides or switches it off, removes them from
that channel at once (only if signed by the same key as their last card).

**Same network.** Every 8 s, `{t:'ember-near', c:card}` is sent as UDP to
`239.255.77.77:47777` (multicast, TTL 1) and to each interface's broadcast
address on port 47777. Peers unheard for 45 s are dropped.

**Same area.** Rows are 0.5° (`fine`) or 1.5° (`coarse`) of latitude; each row
is split into `floor(360·cos(rowLat)/step)` columns, so cells are roughly
square in km. A participant announces (`server`) in its own cell of both grids
and looks up (`client`) the 3×3 block around it in the grid that covers its
radius (`fine` up to 50 km, `coarse` up to 150 km). Anyone within one cell is
always found; the chosen radius (10/25/50/150 km) is then enforced on town
centres. On connect, and every 2 min, each side sends `{t:'near', c:card}`.

## Campfires
A campfire is a live room for one topic. It is not a swarm of its own: it
rides the gossip connections.
```
{t:'fire-here', key, name, fires:[topicId…], terms:[]}        // on connect, on change, and every 60 s
{t:'fire-msg', m:{fire, author, edpk, name, ts, text, sig}}   // sig = Ed25519 over `fire` above
```
`fire-here` declares which topic fires the sender sits at (≤ 8 ids matching
`[a-z0-9-]{1,32}`, sorted), its decoy rooms included: at a decoy fire a client is a
silent member that relays but never speaks or shows it. Members unheard for
3 min are dropped. A fire is **lit**
for a client when at least two others sit at it. Messages (≤ 400 chars, `ts`
within 15 min, name without `|` or control characters) are accepted only for
fires the receiver sits at, verified, checked against the author's published
key when known, rate-limited per author (burst 5, then 1 per 2 s), deduplicated,
and relayed once to the other members' connections. They are kept in memory
only (last 200 per fire) and dropped when the fire goes out. Desktop sends
`terms` empty: nothing from the compass leaves the device.

## Moderation lists
`modlist` blocks are opt-in. A client may **subscribe** to an author's list:
every key on the newest list is hidden for it. It may also use the lists of
the authors it follows as a signal: a key on two or more of them is hidden from
Discover, a key on one is ranked down. Keys the client follows are never
hidden. Lists only ever change what the subscriber sees and relays.

## Direct messages
1. On connect both sides send `{t:'dmhello', v:2, key, chal}` (32 random bytes, hex).
2. Each answers with `{t:'dmproof', sig}` = Ed25519 over the `dm` string above.
3. A socket is the recipient only once its proof verifies against the key
   published in that author's profile. Only then does it receive queued messages.
4. `{t:'dm', from, to, edpk, ts, mid, p:{n, c}}` where `p` is
   `crypto_box(JSON.stringify({k, d}))`: `k` = `'t'` text, `'i'` image data
   URL, `'v'` voice data URL.
