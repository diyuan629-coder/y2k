/**
 * Y2K Collage Maker - Vercel Edge Function
 * 路径: api/generate.js
 * 部署后自动映射为 POST /api/generate 接口
 * 需要在 Vercel 项目设置中配置环境变量：
 *   - GEMINI_API_KEY
 *   - TURNSTILE_SECRET
 *
 * 注意：本版本暂时去掉了每日限流功能（Cloudflare KV 在 Vercel 上没有直接对应物），
 * 先保证核心功能跑通。等上线稳定后，可以接入 Vercel KV 或 Upstash Redis 补上限流。
 */

export const config = {
  runtime: "edge",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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

// ─── 入口函数 ──────────────────────────────────────────────────────────────────
// Vercel Edge Function 用标准 Web API 的 Request/Response，写法和 Cloudflare Worker 非常接近

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return errorResp("Method not allowed", 405);
  }

  const ip = request.headers.get("x-forwarded-for") || "unknown";

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
  const tsOk = await verifyTurnstile(turnstileToken, ip, process.env.TURNSTILE_SECRET);
  if (!tsOk) {
    return errorResp("Human verification failed. Please try again.", 403);
  }

  // 6. 限流：暂时跳过（见文件顶部说明），后续可接入 Vercel KV / Upstash Redis 补上

  // 7. Build Gemini request
  const base64Image = btoa(String.fromCharCode(...new Uint8Array(imageBytes)));
  const prompt = PROMPT;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${process.env.GEMINI_API_KEY}`;

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
