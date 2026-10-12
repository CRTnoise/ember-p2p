# Security model

Ember is alpha software built by one person. It has not had an external
audit. This page says plainly what it protects and what it doesn't, so you
can decide what to use it for.

## What is protected
- **Authorship.** Your feed is a signed append-only Hypercore log; nobody can
  write to it or alter it without your key. Gossiped announcements carry
  Ed25519 signatures (v2 binds text, kind, quote/reply target and media), so
  a relay can't forge or modify your posts. Deletes are signed too.
- **DM contents.** End-to-end encrypted (`crypto_box`, X25519 +
  XSalsa20-Poly1305), authenticated to the sender's published key. Queued
  messages are only handed to a peer that proves it holds the recipient's key.
- **The app itself from hostile content.** Everything read from other
  people's feeds is reduced to a whitelisted shape before use; media must be
  strict data URLs; the desktop window runs sandboxed with a CSP, no remote
  loads, no navigation, no permissions beyond microphone and notifications.

## What is NOT protected
- **Your IP address.** Ember is peer-to-peer: every peer you connect to (feed
  replication, gossip buckets, DMs) sees your IP. There is no Tor/relay
  layer. Do not treat Ember as anonymous.
- **The network edge.** Joining the DHT contacts the public HyperDHT
  bootstrap nodes, and when two peers can't hole-punch, traffic may be relayed
  through another DHT node (still end-to-end encrypted by Noise).
- **Public posts are public.** They're replicated by followers and gossiped
  into discovery buckets by meaning. Deleting a post stops it spreading and
  clears honest peers' copies; it cannot recall copies others saved.
- **Your social graph.** Follows are blocks in your public feed.
- **DM metadata.** Inbox topics are derived from public keys, so anyone can
  sit in yours and see who connects to it, when, from which IP, and how big
  the messages are. Only the contents are hidden.
- **Forward secrecy.** DMs use static keys. If your identity key leaks,
  recorded past DMs can be decrypted. There's no key rotation or revocation
  yet.
- **First contact.** A stranger's key is trusted on first use (TOFU) until
  their profile replicates to you.
- **Data at rest.** Local storage and the identity backup file are not
  encrypted. Anyone with access to your device or that file is you.
- **Nearby (when you turn it on).** SAME NETWORK broadcasts your name and
  key to everyone on the local network every few seconds, for as long as it's
  on. SAME AREA tells anyone who joins the same grid cells that your key is
  near your town, along with your IP address, as with any swarm. LOCATE ME
  reads the PC's position from the operating system (on Windows, its Location
  service, which may itself use Microsoft's Wi-Fi positioning), snaps it to the
  nearest town in the bundled list, and discards it: only the town's centre is
  ever stored or sent. Distances shown are between town centres, so they can't
  be used to triangulate anyone. In a small town, the town is still a real
  location.
- **Nearby can't verify where anyone is.** With no server, a location always
  comes from the sender's own machine: anyone can type another town, fake
  their OS location, or run a modified client to watch an area. Treat a Nearby
  town as a claim, like a profile bio. Both channels are off by default; HIDE
  ME FROM NEARBY (tab or tray) stops everything at once and sends a signed
  "bye" so you disappear from other people's lists immediately. Cards are
  signed, and shown as UNCONFIRMED until the sender's profile has replicated
  and their key matches it.
- **Spam / Sybil.** Per-connection rate limits exist, but nothing stops
  someone from making many identities and filling a discovery bucket.

## Reporting a vulnerability
Please use GitHub's **Report a vulnerability** button (Security tab) rather
than a public issue, so it can be fixed before it's widely known.
