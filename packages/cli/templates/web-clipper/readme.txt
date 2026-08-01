SkillWiki Obsidian Web Clipper template

1. Open Obsidian Web Clipper Settings in the browser profile that will capture this vault.
2. Import llm-wiki-clippings.json.
3. Confirm the destination path is raw/articles and the behavior is Create.
4. Repeat the import for every browser profile that should capture into this vault.

The generic template preserves Web Clipper's {{content}} output. Remote HTTP(S)
images remain external dependencies and are not guaranteed to be downloaded or
available offline.

For attended local asset materialization, an agent may choose any URL-friendly
path under raw/assets/. Write the asset first, use an explicit vault-qualified
Obsidian embed such as ![[raw/assets/example/diagram.png]], verify the target and
preview, and only then finalize the new raw capture. Referenced asset paths are
stable after capture.
