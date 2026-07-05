const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const PROMPT = `Transform this photo into a Y2K photocard collage ("gu ka") style poster. Highly saturated colors, layered sticker-style decorative elements with bold white outlines, dreamy collage composition. Preserve the subject's face and identity accurately.`;

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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResp("Invalid form data");
  }

  const imageFile = formData.get("image");
  const turnstileToken = formData.get("cf-turnstile-response");

  if (!imageFile || typeof imageFile === "string") return errorResp("No image provided");
  if (!turnstileToken) return errorResp("Human verification required");

  const imageBytes = await imageFile.arrayBuffer();
  if (imageBytes.byteLength > 8 * 1024 * 1024) return errorResp("Image too large (max 8 MB)");

  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(imageFile.type)) return errorResp("Unsupported image format.");

  const tsOk = await verifyTurnstile(turnstileToken, ip, env.TURNSTILE_SECRET);
  if (!tsOk) return errorResp("Human verification failed.", 403);

  const base64Image = btoa(String.fromCharCode(...new Uint8Array(imageBytes)));

  const geminiUrl = "https://maas-openapi.wanjiedata.com/api/v1beta/models/gemini-3.1-flash-image:generateContent";

  const geminiBody = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: imageFile.type, data: base64Image } }] }],
    generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
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
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GEMINI_API_KEY}`,
      },
      body: JSON.stringify(geminiBody),
    });
  } catch {
    return errorResp("AI service unreachable.", 502);
  }

  if (!geminiRes.ok) return errorResp("AI generation failed.", 502);

  const geminiData = await geminiRes.json();
  const parts = geminiData?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p.inline_data?.mime_type?.startsWith("image/"));
  if (!imgPart) return errorResp("AI returned no image.", 502);

  return jsonResp({ ok: true, image: imgPart.inline_data.data, mimeType: imgPart.inline_data.mime_type });
}
