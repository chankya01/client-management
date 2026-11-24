import {
  apiJson,
  currentProfile,
  handleApiError,
  internalRoles,
  supabaseAdminFetch,
  tablePath
} from "../../_supabaseAdmin.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";
const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 6000;
const MAX_CONTEXT_LENGTH = 12000;

function cleanText(value, maxLength = MAX_MESSAGE_LENGTH) {
  return String(value || "").trim().slice(0, maxLength);
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[phone redacted]")
    .replace(/https?:\/\/[^\s)]+/gi, "[link redacted]")
    .slice(0, 1600);
}

function searchTerms(value) {
  return [...new Set(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((term) => term.length > 3)
  )].slice(0, 24);
}

async function relatedConversationContext(prompt) {
  try {
    const rows = await supabaseAdminFetch(
      tablePath(
        "request_messages",
        "?select=message,is_internal,created_at&is_internal=eq.false&order=created_at.desc&limit=300"
      )
    );
    const terms = searchTerms(prompt);
    return (rows || [])
      .map((row) => {
        const text = redactSensitiveText(row.message);
        const normalized = text.toLowerCase();
        const score = terms.reduce(
          (total, term) => total + (normalized.includes(term) ? 1 : 0),
          0
        );
        return { text, score };
      })
      .filter((row) => row.score > 0 && row.text)
      .sort((left, right) => right.score - left.score)
      .slice(0, 8)
      .map((row, index) => `Example ${index + 1}: ${row.text}`)
      .join("\n");
  } catch (error) {
    console.warn("[AI Assistant] historical context unavailable", error);
    return "";
  }
}

function assistantSystemPrompt() {
  return `You are the AI Assistant inside a client-management dashboard.

Your job is to help internal staff understand client questions and draft useful replies. The user may also ask for proposal drafts or dashboard analysis.

Rules:
- Answer the questions in the current client message directly and completely.
- Use the current conversation and the anonymized examples supplied as context.
- Do not mention or identify other clients. Do not reveal private data from examples.
- Never invent prices, timelines, commitments, legal terms, or project facts.
- If the context is insufficient, clearly list what is unanswered or needs confirmation.
- Drafts are suggestions only. Never claim that a message was sent and never send email.
- Do not create, edit, or delete records from this chat yet; describe the proposed action and ask for confirmation instead.
- Use concise, professional language suitable for a client-facing reply.`;
}

export async function POST(request) {
  try {
    const profile = await currentProfile(request);
    if (!internalRoles.has(profile.role)) {
      return apiJson({ error: "Only internal team members can use the AI Assistant." }, 403);
    }

    const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
    if (!apiKey) {
      return apiJson({
        error: "AI Assistant is not configured yet. Add ANTHROPIC_API_KEY to the server environment."
      }, 503);
    }

    const body = await request.json().catch(() => ({}));
    const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = incomingMessages
      .slice(-MAX_MESSAGES)
      .map((message) => ({
        role: message?.role === "assistant" ? "assistant" : "user",
        content: cleanText(message?.content)
      }))
      .filter((message) => message.content);

    if (!messages.length || messages[messages.length - 1].role !== "user") {
      return apiJson({ error: "A user message is required." }, 400);
    }

    const suppliedContext = cleanText(body.context, MAX_CONTEXT_LENGTH);
    const prompt = messages[messages.length - 1].content;
    const historicalContext = await relatedConversationContext(`${prompt}\n${suppliedContext}`);
    const contextBlock = [
      suppliedContext ? `Current dashboard context:\n${suppliedContext}` : "",
      historicalContext ? `Similar approved conversation examples:\n${historicalContext}` : ""
    ].filter(Boolean).join("\n\n");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: 1200,
        system: assistantSystemPrompt(),
        messages: [
          ...(contextBlock ? [{ role: "user", content: `Use this context when relevant:\n${contextBlock}` }] : []),
          ...messages
        ]
      }),
      cache: "no-store"
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return apiJson({
        error: payload?.error?.message || `Anthropic request failed (${response.status}).`
      }, 502);
    }

    const answer = (payload.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    return apiJson({
      message: answer || "I could not generate a response from the available context.",
      model: payload.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL
    });
  } catch (error) {
    return handleApiError(error);
  }
}
