/**
 * Fetch-based LLM client (same approach as urlbar-ai).
 * OpenAI-compatible chat completions + Ollama native stream format.
 */

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

const LLM_LIMITS = {
  RETRY_MAX_ATTEMPTS: 3,
  RETRY_BASE_DELAY_MS: 1000,
  RETRY_MAX_DELAY_MS: 10000,
  RENDER_DEBOUNCE_MS: 50,
};

let markedLib = null;
let DOMPurifyLib = null;

const HTTP_STATUS = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  TOO_MANY_REQUESTS: 429,
  SERVER_ERROR_MIN: 500,
};

function sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * @param {string} url
 * @param {RequestInit} options
 * @param {AbortSignal|null} signal
 */
async function fetchWithRetry(url, options = {}, signal = null) {
  const maxAttempts = LLM_LIMITS.RETRY_MAX_ATTEMPTS;
  const baseDelay = LLM_LIMITS.RETRY_BASE_DELAY_MS;
  const maxDelay = LLM_LIMITS.RETRY_MAX_DELAY_MS;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal });
      if (response.ok) return response;

      if (RETRYABLE_STATUSES.includes(response.status) && attempt < maxAttempts - 1) {
        await response.text().catch(() => "");
        const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
        await sleepWithAbort(delay, signal);
        continue;
      }

      const errorText = await response.text().catch(() => "");
      lastError = new Error(
        `API error: ${response.status} ${response.statusText}${errorText ? ` — ${errorText.slice(0, 200)}` : ""}`
      );
      throw lastError;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      const isRetryable =
        err.name === "TypeError" ||
        (err.message && /network|fetch|failed|timeout|connection|refused/i.test(err.message));
      if (isRetryable && attempt < maxAttempts - 1) {
        const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
        await sleepWithAbort(delay, signal);
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error("Request failed after retries");
}

/**
 * Load marked + DOMPurify from vendors/ next to this script.
 */
export function initMarkdownVendors() {
  if (markedLib && DOMPurifyLib) return true;
  try {
    const currentScriptPath = Components.stack.filename;
    const scriptDir = currentScriptPath.substring(0, currentScriptPath.lastIndexOf("/") + 1);
    const vendorsDir = scriptDir + "vendors/";
    Services.scriptloader.loadSubScript(vendorsDir + "marked.min.js");
    Services.scriptloader.loadSubScript(vendorsDir + "purify.min.js");
    markedLib = typeof marked !== "undefined" ? marked : null;
    DOMPurifyLib = typeof DOMPurify !== "undefined" ? DOMPurify : null;
    return !!(markedLib && DOMPurifyLib);
  } catch {
    markedLib = null;
    DOMPurifyLib = null;
    return false;
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const EXCERPT_TAG_RE = /<excerpt>([\s\S]*?)<\/excerpt>/gi;
const INCOMPLETE_EXCERPT_RE = /<excerpt>([\s\S]*)$/i;

/**
 * Replace excerpt blocks with placeholders before markdown parsing.
 * Incomplete trailing excerpts are kept visible while streaming.
 * @param {string} markdown
 * @returns {{ markdown: string, excerpts: string[], streamingExcerptIndex: number|null }}
 */
function extractExcerptPlaceholders(markdown) {
  const excerpts = [];
  EXCERPT_TAG_RE.lastIndex = 0;

  let processed = markdown.replace(EXCERPT_TAG_RE, (_match, inner) => {
    const index = excerpts.length;
    excerpts.push(String(inner).trim());
    return `\n\n%%EXCERPT_${index}%%\n\n`;
  });

  let streamingExcerptIndex = null;
  processed = processed.replace(INCOMPLETE_EXCERPT_RE, (_match, inner) => {
    const index = excerpts.length;
    excerpts.push(String(inner).trim());
    streamingExcerptIndex = index;
    return `\n\n%%EXCERPT_${index}%%\n\n`;
  });

  return { markdown: processed, excerpts, streamingExcerptIndex };
}

/**
 * Plain text for find-in-page highlighting (strip common markdown syntax).
 * @param {string} text
 */
function excerptQuotePlainText(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collapse whitespace for fuzzy page matching.
 * @param {string} text
 */
function normalizeTextForMatch(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

/**
 * Find phrase in page text, allowing flexible whitespace between words.
 * @param {string} pageText
 * @param {string} phrase
 * @returns {string|null}
 */
function findFlexibleInPage(pageText, phrase) {
  const trimmed = normalizeTextForMatch(phrase);
  if (!trimmed || trimmed.length < 4) return null;

  const attempts = [trimmed, trimmed.replace(/\s+/g, " ")];
  for (const attempt of attempts) {
    const escaped = attempt
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    const match = pageText.match(new RegExp(escaped, "i"));
    if (match) {
      return normalizeTextForMatch(match[0]);
    }
  }
  return null;
}

/**
 * When the model merges text from two DOM nodes, the full quote may not exist on the page.
 * Pick the longest substring that does match (prefer whole sentences).
 * @param {string} quote - Raw or markdown excerpt body.
 * @param {string} pageText - Extracted page text (same pipeline as page context).
 * @returns {string}
 */
export function resolveExcerptHighlightSearchText(quote, pageText) {
  const plain = excerptQuotePlainText(quote);
  const page = normalizeTextForMatch(pageText);
  if (!plain || !page) return plain;

  const direct = findFlexibleInPage(page, plain);
  if (direct) return direct;

  const words = plain.split(/\s+/).filter(Boolean);
  let best = "";
  const minWords = 3;

  const sentenceParts = plain
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
    .sort((a, b) => b.length - a.length);

  for (const sentence of sentenceParts) {
    const hit = findFlexibleInPage(page, sentence);
    if (hit && hit.length > best.length) {
      best = hit;
    }
  }

  if (best.length >= plain.length * 0.45) {
    return best;
  }

  const maxLen = Math.min(words.length, 80);
  for (let len = maxLen; len >= minWords; len--) {
    for (let i = 0; i <= words.length - len; i++) {
      const phrase = words.slice(i, i + len).join(" ");
      const hit = findFlexibleInPage(page, phrase);
      if (hit && hit.length > best.length) {
        best = hit;
      }
    }
    if (best.length >= plain.length * 0.55) break;
  }

  return best || plain;
}

/**
 * Turn excerpt placeholders into clickable citation blocks.
 * @param {string} html
 * @param {string[]} excerpts
 * @param {number|null} streamingExcerptIndex
 * @param {typeof marked | null} marked
 */
function injectExcerptBlocks(html, excerpts, streamingExcerptIndex, marked) {
  return html.replace(/%%EXCERPT_(\d+)%%/g, (_match, indexStr) => {
    const index = Number.parseInt(indexStr, 10);
    const source = excerpts[index];
    if (source === undefined) return "";

    let innerHtml = escapeHtml(source);
    if (marked) {
      try {
        innerHtml = marked.parse(source, { gfm: true, breaks: false });
      } catch {
        innerHtml = escapeHtml(source);
      }
    }

    const quote = excerptQuotePlainText(source);
    const isStreaming = streamingExcerptIndex === index;
    const streamingClass = isStreaming ? " page-excerpt-streaming" : "";
    const attrs = quote
      ? ` data-excerpt-quote="${escapeHtml(quote)}" tabindex="0" role="button" title="Find on page"`
      : ` tabindex="-1" aria-busy="true"`;
    const actionHtml =
      quote && !isStreaming
        ? `<div class="page-excerpt-action">Find on Page ` +
          `<span class="page-excerpt-arrow" aria-hidden="true">→</span></div>`
        : "";

    return (
      `<blockquote class="page-excerpt${streamingClass}"${attrs}>` +
      `<div class="page-excerpt-quote">${innerHtml}</div>${actionHtml}</blockquote>`
    );
  });
}

/**
 * Insert HTML via DOMParser (safe in XUL — avoids innerHTML XML errors on br/hr).
 * @param {HTMLElement} element
 * @param {string} html
 */
function setElementHtmlFromMarkup(element, html) {
  element.replaceChildren();
  const trimmed = String(html ?? "").trim();
  if (!trimmed) return;

  const doc = new DOMParser().parseFromString(trimmed, "text/html");
  const fragment = document.createDocumentFragment();
  for (const node of doc.body.childNodes) {
    fragment.appendChild(node.cloneNode(true));
  }
  element.appendChild(fragment);
}

function renderMarkdownFallback(text, element) {
  const html = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n\n+/g, "</p><p>")
    .replace(/\n/g, "<br />");
  setElementHtmlFromMarkup(element, `<p>${html}</p>`);
}

/**
 * @param {string} text
 * @param {HTMLElement} element
 */
export function renderMarkdownToElement(text, element) {
  if (!text) {
    element.replaceChildren();
    return;
  }

  if (!markedLib || !DOMPurifyLib) {
    initMarkdownVendors();
  }

  if (markedLib && DOMPurifyLib) {
    try {
      const { markdown, excerpts, streamingExcerptIndex } = extractExcerptPlaceholders(text);
      const rawHtml = markedLib.parse(markdown, { gfm: true, breaks: false });
      const withExcerpts = injectExcerptBlocks(rawHtml, excerpts, streamingExcerptIndex, markedLib);
      const withClasses = withExcerpts
        .replace(/<table>/g, '<table class="llm-markdown-table">')
        .replace(/<hr>/gi, '<hr class="llm-markdown-hr" />')
        .replace(/<a href=/g, '<a target="_blank" rel="noopener" href=');
      const sanitized = DOMPurifyLib.sanitize(withClasses.trim(), {
        ALLOWED_URI_REGEXP: /^https?:\/\//i,
        ADD_ATTR: ["target", "rel", "data-excerpt-quote", "tabindex", "role", "title", "aria-busy", "class"],
      });
      setElementHtmlFromMarkup(element, sanitized.trim());
      return;
    } catch (err) {
      console.debug("AskOnPage: markdown rendering failed, using plain-text fallback", err);
    }
  }
  renderMarkdownFallback(text, element);
}

/**
 * Provider metadata + pref keys (Ask-On-Page prefs).
 */
const PROVIDER_REGISTRY = {
  mistral: {
    label: "Mistral AI",
    faviconDomain: "mistral.ai",
    apiKeyUrl: "https://console.mistral.ai/api-keys/",
    apiKeyPref: "extension.ask-on-page.mistral-api-key",
    modelPref: "extension.ask-on-page.mistral-model",
    defaultModel: "mistral-medium-latest",
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    kind: "openai",
  },
  openai: {
    label: "OpenAI",
    faviconDomain: "chatgpt.com",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    apiKeyPref: "extension.ask-on-page.openai-api-key",
    modelPref: "extension.ask-on-page.openai-model",
    defaultModel: "gpt-5.2",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    kind: "openai",
  },
  gemini: {
    label: "Google Gemini",
    faviconDomain: "gemini.google.com",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    apiKeyPref: "extension.ask-on-page.gemini-api-key",
    modelPref: "extension.ask-on-page.gemini-model",
    defaultModel: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    kind: "gemini",
  },
  ollama: {
    label: "Ollama (local)",
    faviconDomain: "ollama.com",
    apiKeyUrl: "",
    apiKeyPref: null,
    modelPref: "extension.ask-on-page.ollama-model",
    defaultModel: "mistral",
    baseUrlPref: "extension.ask-on-page.ollama-base-url",
    defaultBaseUrl: "http://localhost:11434/api/chat",
    kind: "ollama",
    customModel: true,
  },
  claude: {
    label: "Anthropic Claude",
    faviconDomain: "anthropic.com",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    apiKeyPref: "extension.ask-on-page.claude-api-key",
    modelPref: "extension.ask-on-page.claude-model",
    defaultModel: "claude-opus-4-1",
    baseUrl: "https://api.anthropic.com/v1/messages",
    kind: "anthropic",
  },
  openrouter: {
    label: "OpenRouter",
    faviconDomain: "openrouter.ai",
    apiKeyUrl: "https://openrouter.ai/keys",
    apiKeyPref: "extension.ask-on-page.openrouter-api-key",
    modelPref: "extension.ask-on-page.openrouter-model",
    defaultModel: "google/gemini-2.5-flash",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    kind: "openai",
    customModel: true,
  },
};

/**
 * @param {string} key
 * @param {object} prefs - object with getPref/setPref
 */
export function resolveProvider(key, prefs) {
  const def = PROVIDER_REGISTRY[key] || PROVIDER_REGISTRY.gemini;
  let baseUrl = def.baseUrl;
  if (def.kind === "ollama") {
    const raw = prefs.getPref(def.baseUrlPref, def.defaultBaseUrl);
    baseUrl = raw.includes("/chat") ? raw : raw.replace(/\/+$/, "") + "/chat";
  }
  return {
    key,
    name: def.label,
    label: def.label,
    kind: def.kind,
    apiKey: def.apiKeyPref ? prefs.getPref(def.apiKeyPref, "") : null,
    model: prefs.getPref(def.modelPref, def.defaultModel),
    baseUrl,
    faviconUrl: `https://s2.googleusercontent.com/s2/favicons?domain_url=https://${def.faviconDomain}&sz=32`,
    apiKeyUrl: def.apiKeyUrl,
    apiPref: def.apiKeyPref,
    modelPref: def.modelPref,
    needsApiKey: def.apiKeyPref !== null,
  };
}

/**
 * UI-facing provider objects (compatible with existing settings/findbar code).
 * @param {object} prefs
 */
export function createProviderFacades(prefs) {
  const facades = {};
  for (const key of Object.keys(PROVIDER_REGISTRY)) {
    const def = PROVIDER_REGISTRY[key];
    facades[key] = {
      name: key,
      label: def.label,
      faviconUrl: `https://s2.googleusercontent.com/s2/favicons?domain_url=https://${def.faviconDomain}&sz=32`,
      apiKeyUrl: def.apiKeyUrl,
      apiPref: def.apiKeyPref,
      modelPref: def.modelPref,
      customModel: !!def.customModel,
      modelPlaceholder: def.defaultModel || "",
      AVAILABLE_MODELS: [],
      get apiKey() {
        return def.apiKeyPref ? prefs.getPref(def.apiKeyPref, "") : "not_required";
      },
      set apiKey(v) {
        if (def.apiKeyPref && typeof v === "string") prefs.setPref(def.apiKeyPref, v);
      },
      get model() {
        return prefs.getPref(def.modelPref, def.defaultModel);
      },
      set model(v) {
        if (typeof v === "string") prefs.setPref(def.modelPref, v);
      },
      getModel() {
        return this.model;
      },
    };
  }
  return facades;
}

/**
 * @param {string} systemPrompt
 * @param {Array<{role:string,content:string}>} history
 */
export function buildChatMessages(systemPrompt, history) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const m of history) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    messages.push({ role: m.role, content: normalizeMessageContent(m.content) });
  }
  return messages;
}

/**
 * Normalize a message's content field to a plain string, whether it arrived
 * as a string, a content-part array (e.g. `[{ text }]`), or something else.
 * @param {unknown} content
 * @returns {string}
 */
function normalizeMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text || "").join("");
  return String(content ?? "");
}

function buildRequestUrl(provider) {
  if (provider.kind === "ollama") {
    return provider.baseUrl;
  }
  if (provider.kind === "gemini" && provider.apiKey) {
    const base = provider.baseUrl.replace(/\/+$/, "");
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    return `${url}?key=${encodeURIComponent(provider.apiKey)}`;
  }
  const base = provider.baseUrl.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function buildRequestHeaders(provider) {
  const headers = { "Content-Type": "application/json" };
  if (provider.kind === "ollama") return headers;
  if (provider.kind === "anthropic") {
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
  if (provider.kind === "gemini") return headers;
  headers.Authorization = `Bearer ${provider.apiKey}`;
  if (provider.key === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/Zylaah/Ask-On-Page";
    headers["X-Title"] = "Ask On Page";
  }
  return headers;
}

function buildRequestBody(provider, messages, stream, sampling = {}) {
  const temperature = sampling.temperature ?? 0.7;
  const maxTokens = sampling.maxTokens ?? 2048;

  if (provider.kind === "anthropic") {
    const system = messages.find((m) => m.role === "system")?.content || "";
    const chatMessages = messages.filter((m) => m.role !== "system");
    return {
      model: provider.model,
      max_tokens: maxTokens,
      system,
      messages: chatMessages.map((m) => ({ role: m.role, content: m.content })),
      stream,
    };
  }

  return {
    model: provider.model,
    messages,
    stream,
    temperature,
    max_tokens: maxTokens,
  };
}

/**
 * @param {Error} error
 * @returns {string}
 */
export function formatLlmError(error) {
  const msg = (error?.message || String(error)).toLowerCase();
  const statusMatch = msg.match(/api error:\s*(\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : null;
  if (status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN) {
    return "Invalid API key. Check your settings.";
  }
  if (status === HTTP_STATUS.TOO_MANY_REQUESTS) return "Rate limit exceeded. Wait a moment and try again.";
  if (status >= HTTP_STATUS.SERVER_ERROR_MIN) return "Service temporarily unavailable. Try again later.";
  if (/network|fetch|connection|timeout|refused/i.test(msg)) {
    return "Connection error. Check your network or local server.";
  }
  return error?.message || "Something went wrong.";
}

/**
 * @param {string} data
 * @returns {{ done?: boolean, text?: string }}
 */
function parseOpenAiSseData(data) {
  if (data === "[DONE]") return { done: true };

  const json = JSON.parse(data);
  if (json.error) {
    throw new Error(`API error: ${extractApiErrorMessage(json.error)}`);
  }

  const text =
    json.choices?.[0]?.delta?.content ??
    json.choices?.[0]?.message?.content ??
    json.candidates?.[0]?.content?.parts?.[0]?.text;

  return { text: text || undefined };
}

/**
 * @param {object|string} error
 * @returns {string}
 */
function extractApiErrorMessage(error) {
  return error.message || error.status || (typeof error === "string" ? error : JSON.stringify(error));
}

/**
 * @param {string} buffer
 */
function throwIfJsonErrorBody(buffer) {
  const trimmed = buffer.trim();
  if (!trimmed.startsWith("{")) return;

  try {
    const json = JSON.parse(trimmed);
    if (json.error) {
      throw new Error(`API error: ${extractApiErrorMessage(json.error)}`);
    }
  } catch (err) {
    if (err.message?.startsWith("API error:")) throw err;
  }
}

/**
 * Read a fetch response body as a stream of newline-delimited text lines,
 * carrying any partial trailing line over to the next chunk.
 * @param {Response} response
 */
async function* readResponseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    yield* lines;
  }

  // Surface any trailing text that never received a closing newline.
  if (buffer) yield buffer;
}

/**
 * Stream chat completion; yields text deltas.
 * @param {object} provider
 * @param {Array} messages
 * @param {AbortSignal} signal
 */
export async function* streamChatText(provider, messages, signal, sampling = {}) {
  if (provider.kind === "anthropic") {
    yield* streamAnthropic(provider, messages, signal, sampling);
    return;
  }

  const url = buildRequestUrl(provider);
  const response = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: buildRequestHeaders(provider),
      body: JSON.stringify(buildRequestBody(provider, messages, true, sampling)),
    },
    signal
  );

  if (!response.body) {
    throw new Error("API error: empty streaming response body");
  }

  const isOllama = provider.kind === "ollama";

  for await (const line of readResponseLines(response)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("data: ")) {
      const data = trimmed.slice(6);
      try {
        const parsed = parseOpenAiSseData(data);
        if (parsed.done) return;
        if (parsed.text) yield parsed.text;
      } catch (err) {
        if (err.message?.startsWith("API error:")) throw err;
      }
    } else if (isOllama) {
      try {
        const json = JSON.parse(trimmed);
        const text = json.message?.content;
        if (text) yield text;
        if (json.done) return;
      } catch (err) {
        console.debug("AskOnPage: Ollama stream chunk parse failed", err);
      }
    } else {
      throwIfJsonErrorBody(trimmed);
    }
  }
}

async function* streamAnthropic(provider, messages, signal, sampling = {}) {
  const response = await fetchWithRetry(
    provider.baseUrl,
    {
      method: "POST",
      headers: buildRequestHeaders(provider),
      body: JSON.stringify(buildRequestBody(provider, messages, true, sampling)),
    },
    signal
  );

  for await (const line of readResponseLines(response)) {
    if (!line.startsWith("data: ")) continue;
    try {
      const json = JSON.parse(line.slice(6));
      if (json.type === "content_block_delta" && json.delta?.text) {
        yield json.delta.text;
      }
    } catch (err) {
      console.debug("AskOnPage: Claude/Anthropic stream chunk parse failed", err);
    }
  }
}

/**
 * Non-streaming completion; returns full assistant text.
 */
export async function completeChatText(provider, messages, signal, sampling = {}) {
  let full = "";
  for await (const chunk of streamChatText(provider, messages, signal, sampling)) {
    full += chunk;
  }
  return full;
}

