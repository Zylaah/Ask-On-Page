<h1 align="center">Ask On Page</h1>
<div align="center">
    <a href="https://zen-browser.app/">
        <img width="240" alt="zen-badge-dark" src="https://raw.githubusercontent.com/heyitszenithyt/zen-browser-badges/fb14dcd72694b7176d141c774629df76af87514e/light/zen-badge-light.png" />
    </a>
</div>

A **fork** of [Vertex-Mods/Browse-Bot](https://github.com/Vertex-Mods/Browse-Bot) scoped to **Findbar AI only**: a floating, Arc-like page-aware chat on the native findbar in **Zen Browser**.

## Features

- **Arc-style findbar** — compact row with Ask button, expandable to full chat
- **Multi-provider LLM** (Gemini, Mistral, OpenAI, Claude, OpenRouter, Ollama)
- **Page content awareness** — page text is sent in the system prompt for Q&A
- **YouTube transcript support** — on YouTube watch pages, fetches captions via YouTube’s internal API and uses a transcript-focused prompt (no page excerpts)
- **Clickable excerpt citations** — quotes from the page in `<excerpt>` blocks, click to highlight on page
- **Streaming responses** via direct API `fetch`, with **marked.js** + **DOMPurify** for markdown
- **Context menu** — Ask AI / summarize with selection templates
- **Zen Command Palette** — Summarize page, expand findbar, open settings
- **Customizable** via Sine settings or `about:config`

## Installation (Sine)

1. Install [Sine](https://github.com/CosmoCreeper/Sine) on Zen Browser.
2. In Sine settings, enable **Enable installing JS from unofficial sources** (`sine.allow-unsafe-js`). Required for this mod’s user script.
3. In Sine → add mod, enter `Zylaah/Ask-On-Page` (or `https://github.com/Zylaah/Ask-On-Page`).
4. Restart Zen when prompted.
5. If you previously installed a broken copy (random mod id, no script), remove it and install again after pushing the fixed `theme.json`.

## Usage

1. Configure an API key (or use Ollama locally) when prompted.
2. `Ctrl+F` — open findbar; **Alt+Enter** or **Ask** sends to AI.
3. `Ctrl+Shift+F` — open findbar directly in AI chat (configurable).
4. Right-click — **Ask AI** / summarize (if enabled).

## Key preferences

| Preference | Default | Description |
| ---------- | ------- | ----------- |
| `extension.ask-on-page.findbar-ai.enabled` | `true` | Master toggle |
| `extension.ask-on-page.llm-provider` | `gemini` | AI provider |
| `extension.ask-on-page.findbar-ai.stream-enabled` | `true` | Stream replies |
| `extension.ask-on-page.findbar-ai.shortcut-findbar` | `ctrl+shift+f` | Open AI findbar |

See Sine settings or upstream README for full provider keys and findbar appearance prefs.

## Privacy

Page text is sent to your chosen LLM provider (except Ollama). Do not use on sensitive pages unless you trust the provider.

## Credits

Based on [Browse-Bot](https://github.com/Vertex-Mods/Browse-Bot) by Bibek Bhusal / Vertex Mods.
