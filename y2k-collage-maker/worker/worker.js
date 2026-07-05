/**
 * Y2K Collage Maker - Cloudflare Worker
 * Proxies requests to Gemini image generation API
 * Secrets: GEMINI_API_KEY, TURNSTILE_SECRET
 * KV Binding: RATE_LIMIT_KV
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const RATE_LIMIT_PER_DAY = 8;

// ─── Prompt ───────────────────────────────────────────────────────────────────
const PROMPT = `Transform this photo into a Y2K photocard collage ("gu ka") style poster. Highly saturated colors, layered sticker-style decorative elements with bold white outlines, dreamy collage composition. Preserve the subject's face and identity accurately.`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function errorResp(message, status = 400) {
  return jsonResp({ ok: false, error: message }, status);
}

async function verifyTurnstile(token, ip, secret) {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  return data.success === true;
}

async function getRateKey(ip) {
  // Key = ip + UTC date string  (resets daily)
  const day = new Date().toISOString().slice(0, 10); // "2026-07-05"
  return `rl:${ip}:${day}`;
}

async function checkAndIncrementRate(kv, ip) {
  const key = await getRateKey(ip);
  const current = parseInt((await kv.get(key)) || "0", 10);
  if (current >= RATE_LIMIT_PER_DAY) return false;
  await kv.put(key, String(current + 1), { expirationTtl: 86400 });
  return true;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

async function handleGenerate(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // 1. Parse multipart form
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResp("Invalid form data");
  }

  const imageFile = formData.get("image");
  const turnstileToken = formData.get("cf-turnstile-response");

  // 2. Basic validation
  if (!imageFile || typeof imageFile === "string") {
    return errorResp("No image provided");
  }
  if (!turnstileToken) {
    return errorResp("Human verification required");
  }

  // 3. File size guard (8 MB)
  const MAX_BYTES = 8 * 1024 * 1024;
  const imageBytes = await imageFile.arrayBuffer();
  if (imageBytes.byteLength > MAX_BYTES) {
    return errorResp("Image too large (max 8 MB)");
  }

  // 4. MIME type guard
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(imageFile.type)) {
    return errorResp("Unsupported image format. Use JPG, PNG or WebP.");
  }

  // 5. Turnstile verification
  const tsOk = await verifyTurnstile(turnstileToken, ip, env.TURNSTILE_SECRET);
  if (!tsOk) {
    return errorResp("Human verification failed. Please try again.", 403);
  }

  // 6. Rate limit
  const allowed = await checkAndIncrementRate(env.RATE_LIMIT_KV, ip);
  if (!allowed) {
    return errorResp("You've reached today's generation limit. Please try again tomorrow.", 429);
  }

  // 7. Build Gemini request
  const base64Image = btoa(String.fromCharCode(...new Uint8Array(imageBytes)));
  const prompt = PROMPT;

  // Using gemini-3.1-flash-image (Nano Banana 2) per spec
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${env.GEMINI_API_KEY}`;

  const geminiBody = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: imageFile.type,
              data: base64Image,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ],
  };

  let geminiRes;
  try {
    geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });
  } catch (err) {
    return errorResp("AI service unreachable. Please try again.", 502);
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => "");
    console.error("Gemini error:", geminiRes.status, errText);
    return errorResp("AI generation failed. Please try again.", 502);
  }

  const geminiData = await geminiRes.json();

  // Extract first image part from response
  try {
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find((p) => p.inline_data?.mime_type?.startsWith("image/"));
    if (!imgPart) {
      return errorResp("AI returned no image. Please try again.", 502);
    }
    return jsonResp({
      ok: true,
      image: imgPart.inline_data.data,
      mimeType: imgPart.inline_data.mime_type,
    });
  } catch {
    return errorResp("Unexpected response from AI service.", 502);
  }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/generate" && request.method === "POST") {
      return handleGenerate(request, env);
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
