# MikeOS for NativeCluster

![Mike](docs/assets/link-image.jpg)

MikeOS is the open-source legal AI platform by
[Open Legal Products](https://github.com/open-legal-products/mike). This
repository is MikeOS made into an app for
[NativeCluster](https://www.nativecluster.com), which runs open AI models on
a group's own Macs.

- **Local.** MikeOS runs on each person's own Mac, and keeps their projects,
  chats and documents on that Mac.
- **Every model call runs on your group's own Macs**, through NativeCluster.
  No hosted AI model is called, and their SDKs are left out of the app.
- **One sign-in, NativeCluster's.** MikeOS has no accounts of its own here.
- **The internet only for what needs it:** case law on CourtListener, web
  search with your own Brave or Tavily key, and the connectors you add.
  NativeCluster shows each of them before you install.

## Get it

In NativeCluster's Store, choose **Get** on MikeOS. It needs a Mac with
Apple silicon and NativeCluster 0.4.23 or later.

## What it does

- Ask questions of your contracts, with answers that cite the page they come
  from
- Draft and redline Word documents with tracked changes
- Run tabular reviews across many documents at once
- Run workflows, and check documents against your playbooks
- Research US case law with CourtListener

Not in this first version: sharing work between people; Google Drive, Gmail
and Calendar; the Word add-in; and scanned PDFs (a PDF needs its text).

## The source

- This branch, `nativecluster-app`, is upstream's commit
  [3422ab5f](https://github.com/open-legal-products/mike/commit/3422ab5ffd91f9b679e3644b59ed3a24fb707ac3)
  (2026-11-23) with the changes that make it a NativeCluster app.
- Each release in NativeCluster's Store is tagged here: MikeOS 2.1.0.1 is
  [`mikeos-2.1.0.1`](https://github.com/nativecluster/mikeos/tree/mikeos-2.1.0.1).
- [`nativecluster/`](nativecluster) holds the app's manifest
  ([`nc-app.json`](nativecluster/nc-app.json)), its launcher, the build
  (`nativecluster/build/build.sh <folder>`, whose header says what it needs)
  and the tests ([`nativecluster/test`](nativecluster/test/README.md)).
- To run Mike in other ways (Docker, Vercel, your own servers), see
  [upstream's README](https://github.com/open-legal-products/mike#readme).

## License

[AGPL-3.0](LICENSE), as upstream. This is a modified version of Mike by Open
Legal Products, changed by NativeCluster from 2026-11-24. It comes with no
warranty.
