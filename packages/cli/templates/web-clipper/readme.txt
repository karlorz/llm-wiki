SkillWiki Obsidian Web Clipper template

Dedicated clip-outbox (v1):
1. Create or select an Obsidian vault at ~/Obsidian/clip-outbox (outside ~/wiki).
2. Create raw/articles and raw/assets in that vault. Set the attachment folder to raw/assets.
3. Open Obsidian Web Clipper Settings in the browser profile that will capture.
4. Import llm-wiki-clippings.json.
5. Select the clip-outbox vault. Keep Add to Obsidian. Do not select ~/wiki.
6. Confirm the destination path is raw/articles and the behavior is Create.
7. Repeat the import for every browser profile. Shipping a new JSON does not update extension storage.
8. Verify with a scratch capture and a repeated same-title save before enabling delivery.

The generic template preserves Web Clipper's {{content}} output. The clip-outbox
worker localizes remote HTTPS images, writes explicit ![[raw/assets/...]] embeds,
and uploads a sibling Markdown index at raw/assets/<capture-id>/note.md. Never use
.txt as the only index. wiki_capture is not clip or image ingress.
